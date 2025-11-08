use std::{
    fmt::{Debug, Formatter},
    str::FromStr,
};

use actix_web::web::Bytes;
use common::api_bindings::{self, DetailedHost, HostState, PairStatus, UndetailedHost};
use log::{error, warn};
use moonlight_common::{
    PairPin, ServerState,
    high::broadcast_magic_packet,
    network::{
        self, ApiError, ClientAppBoxArtRequest, ClientInfo, HostInfo,
        backend::hyper_openssl::HyperOpenSSLError, host_app_box_art, host_app_list, host_cancel,
        host_info, request_client::RequestClient,
    },
    pair::{PairSuccess, generate_new_client, host_pair},
};
use uuid::Uuid;

use crate::app::{
    AppError, AppInner, AppRef, MoonlightClient,
    storage::{StorageHost, StorageHostModify, StorageHostPairInfo},
    user::{AuthenticatedUser, Role, UserId},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HostId(pub u32);

pub struct Host {
    pub(super) app: AppRef,
    pub(super) id: HostId,
    pub(super) cache_storage: Option<StorageHost>,
    // TODO: this cache might be invalid when there's access from multiple users on one host
    pub(super) cache_host_info: Option<HostInfo>,
}

impl Debug for Host {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AppId(pub u32);

pub struct App {
    pub id: AppId,
    pub title: String,
    pub is_hdr_supported: bool,
}

impl From<network::App> for App {
    fn from(value: network::App) -> Self {
        Self {
            id: AppId(value.id),
            title: value.title,
            is_hdr_supported: value.is_hdr_supported,
        }
    }
}
impl From<App> for api_bindings::App {
    fn from(value: App) -> Self {
        Self {
            app_id: value.id.0,
            title: value.title,
            is_hdr_supported: value.is_hdr_supported,
        }
    }
}

impl Host {
    pub fn id(&self) -> HostId {
        self.id
    }

    async fn can_use(&self, user: &mut AuthenticatedUser) -> Result<(), AppError> {
        let owner = self.owner().await?;
        if owner.is_none() || owner == Some(user.id()) || matches!(user.role().await?, Role::Admin)
        {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }

    pub async fn modify(
        &mut self,
        user: &mut AuthenticatedUser,
        modify: StorageHostModify,
    ) -> Result<(), AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        self.cache_storage = None;

        app.storage.modify_host(self.id, modify).await?;

        Ok(())
    }

    pub async fn owner(&self) -> Result<Option<UserId>, AppError> {
        let app = self.app.access()?;

        let host = app.storage.get_host(self.id).await?;

        Ok(host.owner)
    }

    pub async fn undetailed_host_cached(
        &self,
        user: &mut AuthenticatedUser,
    ) -> Result<UndetailedHost, AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        let host = self.storage_host(&app).await?;

        Ok(UndetailedHost {
            host_id: host.id.0,
            name: host.cache.name,
            paired: if host.pair_info.is_some() {
                PairStatus::Paired
            } else {
                PairStatus::NotPaired
            },
            server_state: None,
        })
    }

    async fn use_client<R>(
        &mut self,
        app: &AppInner,
        user: &mut AuthenticatedUser,
        pairing: bool,
        // app, https_capable, client, host, port, client_info
        f: impl AsyncFnOnce(&mut Self, bool, &mut MoonlightClient, &str, u16, ClientInfo) -> R,
    ) -> Result<R, AppError> {
        // TODO: make this mut and store client as cache

        let user_unique_id = user.host_unique_id().await?;
        let host_data = self.storage_host(app).await?;

        let (mut client, https_capable) = if pairing {
            (
                MoonlightClient::with_defaults_long_timeout().map_err(ApiError::RequestClient)?,
                false,
            )
        } else if let Some(pair_info) = host_data.pair_info {
            (
                MoonlightClient::with_certificates(
                    &pair_info.client_private_key,
                    &pair_info.client_certificate,
                    &pair_info.server_certificate,
                )
                .map_err(ApiError::RequestClient)?,
                true,
            )
        } else {
            (
                MoonlightClient::with_defaults().map_err(ApiError::RequestClient)?,
                false,
            )
        };

        let info = ClientInfo {
            unique_id: &user_unique_id,
            uuid: Uuid::new_v4(),
        };

        Ok(f(
            self,
            https_capable,
            &mut client,
            &host_data.address,
            host_data.http_port,
            info,
        )
        .await)
    }
    fn build_hostport(host: &str, port: u16) -> String {
        format!("{host}:{port}")
    }

    async fn storage_host(&self, app: &AppInner) -> Result<StorageHost, AppError> {
        if let Some(host) = self.cache_storage.as_ref() {
            return Ok(host.clone());
        }

        app.storage.get_host(self.id).await
    }

    pub async fn address_port(
        &self,
        user: &mut AuthenticatedUser,
    ) -> Result<(String, u16), AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        let host = app.storage.get_host(self.id).await?;

        Ok((host.address, host.http_port))
    }

    pub async fn pair_info(
        &self,
        user: &mut AuthenticatedUser,
    ) -> Result<StorageHostPairInfo, AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        let host = app.storage.get_host(self.id).await?;

        host.pair_info.ok_or(AppError::HostNotPaired)
    }

    fn is_offline<T>(
        &self,
        result: Result<T, ApiError<<MoonlightClient as RequestClient>::Error>>,
    ) -> Result<Option<T>, AppError> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(ApiError::RequestClient(HyperOpenSSLError::Timeout)) => Ok(None),
            Err(err) => Err(AppError::MoonlightApi(err)),
        }
    }
    // None = Offline
    async fn host_info(
        &mut self,
        app: &AppInner,
        user: &mut AuthenticatedUser,
    ) -> Result<Option<HostInfo>, AppError> {
        self.use_client(
            app,
            user,
            false,
            async |this, https_capable, client, host, port, client_info| {
                let mut info = match this.is_offline(
                    host_info(
                        client,
                        false,
                        &Self::build_hostport(host, port),
                        Some(client_info),
                    )
                    .await,
                ) {
                    Ok(Some(value)) => value,
                    err => return err,
                };

                if https_capable {
                    match host_info(
                        client,
                        true,
                        &Self::build_hostport(host, info.https_port),
                        Some(client_info),
                    )
                    .await
                    {
                        Ok(new_info) => {
                            info = new_info;
                        }
                        Err(ApiError::InvalidXmlStatusCode { message: Some(message) })
                            if message.contains("Certificate")=>
                        {
                            // The host likely removed our paired certificate
                            warn!("Host {this:?} has an error related to certificates. This likely happened because the device was removed from sunshine.");
                        }
                        Err(err) => return Err(err.into()),
                    }
                }

                this.cache_host_info = Some(info.clone());

                Ok(Some(info))
            },
        )
        .await?
    }

    pub async fn undetailed_host(
        &mut self,
        user: &mut AuthenticatedUser,
    ) -> Result<UndetailedHost, AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        match self.host_info(&app, user).await {
            Ok(Some(info)) => {
                let server_state = match ServerState::from_str(&info.state_string) {
                    Ok(state) => Some(state),
                    Err(err) => {
                        warn!(
                            "failed to parse server state of host {self:?}: {:?}, {}",
                            err, info.state_string
                        );

                        None
                    }
                };

                Ok(UndetailedHost {
                    host_id: self.id.0,
                    name: info.host_name,
                    paired: info.pair_status.into(),
                    server_state: server_state.map(HostState::from),
                })
            }
            Ok(None) => {
                let host = self.storage_host(&app).await?;

                let paired = if host.pair_info.is_some() {
                    PairStatus::Paired
                } else {
                    PairStatus::NotPaired
                };

                Ok(UndetailedHost {
                    host_id: self.id.0,
                    name: host.cache.name,
                    paired,
                    server_state: None,
                })
            }
            Err(err) => Err(err),
        }
    }
    pub async fn detailed_host(
        &mut self,
        user: &mut AuthenticatedUser,
    ) -> Result<DetailedHost, AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;
        let host = self.storage_host(&app).await?;

        match self.host_info(&app, user).await {
            Ok(Some(info)) => {
                let server_state = match ServerState::from_str(&info.state_string) {
                    Ok(state) => Some(state),
                    Err(err) => {
                        warn!(
                            "failed to parse server state of host {self:?}: {:?}, {}",
                            err, info.state_string
                        );

                        None
                    }
                };

                Ok(DetailedHost {
                    host_id: self.id.0,
                    name: info.host_name,
                    paired: info.pair_status.into(),
                    server_state: server_state.map(HostState::from),
                    address: host.address,
                    http_port: host.http_port,
                    https_port: info.https_port,
                    external_port: info.external_port,
                    version: info.app_version.to_string(),
                    gfe_version: info.gfe_version,
                    unique_id: info.unique_id.to_string(),
                    mac: info.mac.map(|mac| mac.to_string()),
                    local_ip: info.local_ip,
                    current_game: info.current_game,
                    max_luma_pixels_hevc: info.max_luma_pixels_hevc,
                    server_codec_mode_support: info.server_codec_mode_support,
                })
            }
            Ok(None) => {
                let paired = if host.pair_info.is_some() {
                    PairStatus::Paired
                } else {
                    PairStatus::NotPaired
                };

                Ok(DetailedHost {
                    host_id: self.id.0,
                    name: host.cache.name,
                    paired,
                    server_state: None,
                    address: host.address,
                    http_port: host.http_port,
                    https_port: 0,
                    external_port: 0,
                    version: "Offline".to_string(),
                    gfe_version: "Offline".to_string(),
                    unique_id: "Offline".to_string(),
                    mac: host.cache.mac.map(|mac| mac.to_string()),
                    local_ip: "Offline".to_string(),
                    current_game: 0,
                    max_luma_pixels_hevc: 0,
                    server_codec_mode_support: 0,
                })
            }
            Err(err) => Err(err),
        }
    }

    pub async fn is_paired(
        &mut self,
        user: &mut AuthenticatedUser,
    ) -> Result<PairStatus, AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        match self.host_info(&app, user).await? {
            Some(info) => Ok(info.pair_status.into()),
            None => Ok(PairStatus::NotPaired),
        }
    }

    pub async fn pair(
        &mut self,
        user: &mut AuthenticatedUser,
        pin: PairPin,
    ) -> Result<(), AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        let info = self
            .host_info(&app, user)
            .await?
            .ok_or(AppError::HostNotFound)?;

        if matches!(info.pair_status.into(), PairStatus::Paired) {
            return Err(AppError::HostPaired);
        }

        let modify = self
            .use_client(
                &app,
                user,
                true,
                async |this,_https_capable, client, host, port, client_info| {
                    let auth = generate_new_client()?;

                    let https_address = Self::build_hostport(host, info.https_port);

                    // TODO: device name
                    let PairSuccess { server_certificate, mut client } = host_pair(
                        client,
                        &Self::build_hostport(host, port),
                        &https_address,
                        client_info,
                        &auth.private_key,
                        &auth.certificate,
                        &app.config.moonlight.pair_device_name,
                        info.app_version,
                        pin,
                    )
                    .await
                    // TODO: handle pair error correctly!
                    .unwrap();

                    // Store pair info
                    let (name, mac) = match host_info(
                        &mut client,
                        true,
                        &Self::build_hostport(host, info.https_port),
                        Some(client_info),
                    )
                    .await
                    {
                        Ok(info) => {
                            this.cache_host_info = Some(info.clone());

                            (Some(info.host_name), Some(info.mac))
                        },
                        Err(err) => {
                            warn!("Failed to make https request to host {this:?} after pairing completed: {err}");
                            (None, None)
                        },
                    };

                    Ok::<_, AppError>(StorageHostModify {
                        pair_info: Some(Some(StorageHostPairInfo {
                            client_private_key: auth.private_key,
                            client_certificate: auth.certificate,
                            server_certificate,
                        })),
                        cache_name: name,
                        cache_mac: mac,
                        ..Default::default()
                    })
                },
            )
            .await??;

        self.modify(user, modify).await
    }

    pub async fn unpair(&self, user: &mut AuthenticatedUser) -> Result<Host, AppError> {
        self.can_use(user).await?;

        todo!()
    }

    pub async fn wake(&self, user: &mut AuthenticatedUser) -> Result<(), AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        let storage = self.storage_host(&app).await?;

        if let Some(mac) = storage.cache.mac {
            // TODO: error
            broadcast_magic_packet(mac).await.unwrap();
            Ok(())
        } else {
            Err(AppError::HostNotFound)
        }
    }

    pub async fn list_apps(&mut self, user: &mut AuthenticatedUser) -> Result<Vec<App>, AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        let info = self
            .host_info(&app, user)
            .await?
            .ok_or(AppError::HostOffline)?;

        self.use_client(
            &app,
            user,
            false,
            async |_this, https_capable, client, host, _port, client_info| {
                if !https_capable {
                    return Err(AppError::HostNotPaired);
                }

                let apps = host_app_list(
                    client,
                    &Self::build_hostport(host, info.https_port),
                    client_info,
                )
                .await?;

                let apps = apps.apps.into_iter().map(App::from).collect::<Vec<_>>();

                Ok(apps)
            },
        )
        .await?
    }
    pub async fn app_image(
        &mut self,
        user: &mut AuthenticatedUser,
        app_id: AppId,
    ) -> Result<Bytes, AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        let info = self
            .host_info(&app, user)
            .await?
            .ok_or(AppError::HostOffline)?;

        // TODO: how to reload app images?
        let cache_key = (user.id(), self.id, app_id);
        {
            let app_images = app.app_image_cache.read().await;
            if let Some(app_image) = app_images.get(&cache_key) {
                return Ok(app_image.clone());
            }
        }

        let app_image = self
            .use_client(
                &app,
                user,
                false,
                async |_this, https_capable, client, host, _port, client_info| {
                    if !https_capable {
                        return Err(AppError::HostNotPaired);
                    }

                    let image = host_app_box_art(
                        client,
                        &Self::build_hostport(host, info.https_port),
                        client_info,
                        ClientAppBoxArtRequest { app_id: app_id.0 },
                    )
                    .await?;

                    Ok(image)
                },
            )
            .await??;

        {
            let mut app_images = app.app_image_cache.write().await;
            app_images.insert(cache_key, app_image.clone());
        }

        Ok(app_image)
    }

    pub async fn cancel_app(&mut self, user: &mut AuthenticatedUser) -> Result<(), AppError> {
        self.can_use(user).await?;

        let app = self.app.access()?;

        let info = self
            .host_info(&app, user)
            .await?
            .ok_or(AppError::HostOffline)?;

        self.use_client(
            &app,
            user,
            false,
            async |_this, https_capable, client, host, _port, client_info| {
                if !https_capable {
                    return Err(AppError::Forbidden);
                }

                // TODO: use success
                let success = host_cancel(
                    client,
                    &Self::build_hostport(host, info.https_port),
                    client_info,
                )
                .await?;

                Ok(())
            },
        )
        .await?
    }

    pub async fn delete(self, user: &mut AuthenticatedUser) -> Result<(), AppError> {
        let app = self.app.access()?;

        let host = app.storage.get_host(self.id).await?;

        if host.owner == Some(user.id()) || matches!(user.role().await?, Role::Admin) {
            {
                let mut app_images = app.app_image_cache.write().await;
                app_images.retain(|(_, host_id, _), _| *host_id != self.id);
            }

            drop(app);
            self.delete_no_auth().await
        } else {
            Err(AppError::Forbidden)
        }
    }
    pub async fn delete_no_auth(self) -> Result<(), AppError> {
        let app = self.app.access()?;

        app.storage.remove_host(self.id).await?;

        Ok(())
    }
}
