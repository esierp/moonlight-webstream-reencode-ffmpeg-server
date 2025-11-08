use std::{
    fmt::{Debug, Formatter},
    ops::{Deref, DerefMut},
};

use common::api_bindings::{self, DetailedUser};
use moonlight_common::network::{ApiError, ClientInfo, host_info, request_client::RequestClient};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::app::{
    AppError, AppRef, MoonlightClient,
    auth::{SessionToken, UserAuth},
    host::{Host, HostId},
    password::StoragePassword,
    storage::{
        StorageHostAdd, StorageHostCache, StorageQueryHosts, StorageUser, StorageUserModify,
    },
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Role {
    User,
    Admin,
}

impl From<Role> for api_bindings::UserRole {
    fn from(value: Role) -> Self {
        match value {
            Role::User => Self::User,
            Role::Admin => Self::Admin,
        }
    }
}

impl From<api_bindings::UserRole> for Role {
    fn from(value: common::api_bindings::UserRole) -> Self {
        use common::api_bindings::UserRole;

        match value {
            UserRole::User => Self::User,
            UserRole::Admin => Self::Admin,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct UserId(pub u32);

#[derive(Clone)]
pub struct User {
    pub(super) app: AppRef,
    pub(super) id: UserId,
    // TODO: maybe arc this because the user is getting cloned?
    pub(super) cache_storage: Option<StorageUser>,
}

impl Debug for User {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.id)
    }
}

impl User {
    pub fn id(&self) -> UserId {
        self.id
    }

    async fn storage_user(&mut self) -> Result<StorageUser, AppError> {
        if let Some(storage) = self.cache_storage.as_ref() {
            return Ok(storage.clone());
        }

        let app = self.app.access()?;

        let user = app.storage.get_user(self.id).await?;

        self.cache_storage = Some(user.clone());

        Ok(user)
    }

    pub async fn name(&mut self) -> Result<String, AppError> {
        let storage = self.storage_user().await?;

        Ok(storage.name)
    }
    pub async fn role(&mut self) -> Result<Role, AppError> {
        let storage = self.storage_user().await?;

        Ok(storage.role)
    }

    pub async fn detailed_user(
        &mut self,
        requesting_user: &mut AuthenticatedUser,
    ) -> Result<DetailedUser, AppError> {
        if requesting_user.role().await? == Role::Admin || self.id() == requesting_user.id() {
            self.detailed_user_no_auth().await
        } else {
            Err(AppError::Forbidden)
        }
    }
    pub async fn detailed_user_no_auth(&mut self) -> Result<DetailedUser, AppError> {
        Ok(DetailedUser {
            id: self.id.0,
            name: self.name().await?,
            role: self.role().await?.into(),
        })
    }

    pub async fn modify(&mut self, _: &Admin, modify: StorageUserModify) -> Result<(), AppError> {
        let app = self.app.access()?;

        self.cache_storage = None;

        app.storage.modify_user(self.id, modify).await?;

        Ok(())
    }
    pub async fn delete(self, _: &Admin) -> Result<(), AppError> {
        let app = self.app.access()?;

        app.storage.remove_user(self.id).await?;

        Ok(())
    }

    pub async fn authenticate(mut self, auth: &UserAuth) -> Result<AuthenticatedUser, AppError> {
        match auth {
            UserAuth::UserPassword { username, password } => {
                let storage = self.storage_user().await?;

                if username.as_str() != storage.name.as_str() {
                    // TODO: maybe another error?
                    return Err(AppError::Unauthorized);
                }

                if storage.password.verify(password)? {
                    Ok(AuthenticatedUser { inner: self })
                } else {
                    Err(AppError::CredentialsWrong)
                }
            }
            UserAuth::Session(session) => {
                let app = self.app.access()?;

                let (id, user) = app.storage.get_user_by_session_token(*session).await?;

                if self.id != id {
                    return Err(AppError::SessionTokenNotFound);
                }

                self.cache_storage = self.cache_storage.or(user);

                Ok(AuthenticatedUser { inner: self })
            }
            _ => Err(AppError::Unauthorized),
        }
    }
}

#[derive(Clone)]
pub struct AuthenticatedUser {
    pub(super) inner: User,
}

impl Deref for AuthenticatedUser {
    type Target = User;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
impl DerefMut for AuthenticatedUser {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
}

impl AuthenticatedUser {
    pub async fn detailed_user(&mut self) -> Result<DetailedUser, AppError> {
        self.detailed_user_no_auth().await
    }

    pub async fn set_password(&mut self, password: StoragePassword) -> Result<(), AppError> {
        let app = self.app.access()?;

        self.cache_storage = None;

        app.storage
            .modify_user(
                self.id,
                StorageUserModify {
                    password: Some(password),
                    ..Default::default()
                },
            )
            .await?;

        Ok(())
    }

    pub async fn new_session(&self) -> Result<SessionToken, AppError> {
        let app = self.app.access()?;

        let token = app.storage.create_session_token(self.id).await?;

        Ok(token)
    }

    pub async fn host_unique_id(&mut self) -> Result<String, AppError> {
        let user = self.storage_user().await?;

        // TODO: have an override for user
        Ok(user.name)
    }

    pub async fn hosts(&mut self) -> Result<Vec<Host>, AppError> {
        let app = self.app.access()?;

        let hosts = app
            .storage
            .list_user_hosts(StorageQueryHosts { user_id: self.id })
            .await?
            .into_iter()
            .map(|(host_id, host)| Host {
                app: self.app.clone(),
                id: host_id,
                cache_storage: host,
                cache_host_info: None,
            })
            .collect();

        Ok(hosts)
    }

    pub async fn host(&mut self, host_id: HostId) -> Result<Host, AppError> {
        let app = self.app.access()?;

        let host = app.storage.get_host(host_id).await?;

        if host.owner.is_none() || host.owner == Some(self.id) {
            Ok(Host {
                app: self.app.clone(),
                id: host.id,
                cache_storage: Some(host),
                cache_host_info: None,
            })
        } else {
            Err(AppError::Forbidden)
        }
    }

    pub async fn host_add(&mut self, address: String, http_port: u16) -> Result<Host, AppError> {
        let app = self.app.access()?;

        let unique_id = self.host_unique_id().await?;

        let mut client = MoonlightClient::with_defaults().map_err(ApiError::RequestClient)?;
        let info = host_info(
            &mut client,
            false,
            &format!("{}:{}", address, http_port),
            Some(ClientInfo {
                uuid: Uuid::new_v4(),
                unique_id: &unique_id,
            }),
        )
        .await?;

        let host = app
            .storage
            .add_host(StorageHostAdd {
                owner: Some(self.id),
                address,
                http_port,
                pair_info: None,
                cache: StorageHostCache {
                    name: info.host_name,
                    mac: info.mac,
                },
            })
            .await?;

        Ok(Host {
            // TODO: use storage_host
            app: self.app.clone(),
            id: host.id,
            cache_storage: Some(host),
            cache_host_info: None,
        })
    }

    pub async fn host_delete(&mut self, host_id: HostId) -> Result<(), AppError> {
        let host = self.host(host_id).await?;

        host.delete(self).await?;

        Ok(())
    }

    pub async fn into_admin(self) -> Result<Admin, AppError> {
        match Admin::try_from(self).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err(AppError::Forbidden),
            Err(err) => Err(err),
        }
    }
}

pub struct Admin(AuthenticatedUser);

impl Admin {
    pub async fn try_from(
        mut user: AuthenticatedUser,
    ) -> Result<Result<Admin, AuthenticatedUser>, AppError> {
        match user.role().await? {
            Role::Admin => Ok(Ok(Self(user))),
            _ => Ok(Err(user)),
        }
    }
}

impl Deref for Admin {
    type Target = AuthenticatedUser;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
