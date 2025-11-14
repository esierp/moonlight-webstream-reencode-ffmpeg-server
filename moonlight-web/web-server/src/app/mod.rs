use std::{
    collections::HashMap,
    io,
    ops::Deref,
    sync::{Arc, Weak},
};

use actix_web::{HttpResponse, ResponseError, cookie::Cookie, http::StatusCode, web::Bytes};
use common::config::Config;
use hex::FromHexError;
use log::{error, warn};
use moonlight_common::{
    network::{
        ApiError, backend::hyper_openssl::HyperOpenSSLClient, request_client::RequestClient,
    },
    pair::PairError,
};
use openssl::error::ErrorStack;
use thiserror::Error;
use tokio::sync::RwLock;

use crate::{
    api::auth::COOKIE_SESSION_TOKEN_NAME,
    app::{
        auth::{SessionToken, UserAuth},
        host::{AppId, HostId},
        storage::{Either, Storage, StorageUserAdd, create_storage},
        user::{Admin, AuthenticatedUser, User, UserId},
    },
};

pub mod auth;
pub mod host;
pub mod password;
pub mod storage;
pub mod user;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("the app got destroyed")]
    AppDestroyed,
    #[error("the user was not found")]
    UserNotFound,
    #[error("the user already exists")]
    UserAlreadyExists,
    #[error("the host was not found")]
    HostNotFound,
    #[error("the host was already paired")]
    HostPaired,
    #[error("the host must be paired for this action")]
    HostNotPaired,
    #[error("the host was offline, but the action requires that the host is online")]
    HostOffline,
    // -- Unauthorized
    #[error("the credentials don't exists")]
    CredentialsWrong,
    #[error("the host was not found")]
    SessionTokenNotFound,
    #[error("the action is not allowed because the user is not authorized, 401")]
    Unauthorized,
    // --
    #[error("the action is not allowed with the current privileges, 403")]
    Forbidden,
    // -- Bad Request
    #[error("the authorization header is not a bearer")]
    AuthorizationNotBearer,
    #[error("the authorization header is not a bearer")]
    BearerMalformed,
    #[error("the password is empty")]
    PasswordEmpty,
    #[error("the password is empty")]
    NameEmpty,
    #[error("the authorization header is not a bearer")]
    BadRequest,
    // --
    #[error("openssl error occured: {0}")]
    OpenSSL(#[from] ErrorStack),
    #[error("hex error occured: {0}")]
    Hex(#[from] FromHexError),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("moonlight api error: {0}")]
    MoonlightApi(#[from] ApiError<<MoonlightClient as RequestClient>::Error>),
    #[error("pairing error: {0}")]
    Pairing(#[from] PairError<<MoonlightClient as RequestClient>::Error>),
}

impl ResponseError for AppError {
    fn error_response(&self) -> HttpResponse {
        match self {
            Self::SessionTokenNotFound => {
                let mut response = HttpResponse::Conflict().finish();

                if let Err(err) =
                    response.add_removal_cookie(&Cookie::named(COOKIE_SESSION_TOKEN_NAME))
                {
                    warn!(
                        "failed to set removal cookie for session cookie({COOKIE_SESSION_TOKEN_NAME}): {err:?}"
                    );
                }

                response
            }
            _ => HttpResponse::new(self.status_code()),
        }
    }

    fn status_code(&self) -> StatusCode {
        match self {
            Self::AppDestroyed => StatusCode::INTERNAL_SERVER_ERROR,
            Self::HostNotFound => StatusCode::NOT_FOUND,
            Self::HostNotPaired => StatusCode::FORBIDDEN,
            Self::HostPaired => StatusCode::NOT_MODIFIED,
            Self::HostOffline => StatusCode::GATEWAY_TIMEOUT,
            Self::UserNotFound => StatusCode::NOT_FOUND,
            Self::UserAlreadyExists => StatusCode::CONFLICT,
            Self::CredentialsWrong => StatusCode::UNAUTHORIZED,
            Self::SessionTokenNotFound => StatusCode::UNAUTHORIZED,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::OpenSSL(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Hex(_) => StatusCode::BAD_REQUEST,
            Self::AuthorizationNotBearer => StatusCode::BAD_REQUEST,
            Self::BearerMalformed => StatusCode::BAD_REQUEST,
            Self::PasswordEmpty => StatusCode::BAD_REQUEST,
            Self::NameEmpty => StatusCode::BAD_REQUEST,
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::MoonlightApi(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Pairing(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Clone)]
struct AppRef {
    inner: Weak<AppInner>,
}

impl AppRef {
    fn access(&self) -> Result<impl Deref<Target = AppInner> + 'static, AppError> {
        Weak::upgrade(&self.inner).ok_or(AppError::AppDestroyed)
    }
}

struct AppInner {
    config: Config,
    storage: Arc<dyn Storage + Send + Sync>,
    app_image_cache: RwLock<HashMap<(UserId, HostId, AppId), Bytes>>,
}

pub type MoonlightClient = HyperOpenSSLClient;

pub struct App {
    inner: Arc<AppInner>,
}

impl App {
    pub async fn new(config: Config) -> Result<Self, anyhow::Error> {
        let app = AppInner {
            storage: create_storage(config.data_storage.clone()).await?,
            config,
            app_image_cache: Default::default(),
        };

        Ok(Self {
            inner: Arc::new(app),
        })
    }

    fn new_ref(&self) -> AppRef {
        AppRef {
            inner: Arc::downgrade(&self.inner),
        }
    }

    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    /// admin: The admin that tries to do this action
    pub async fn add_user(
        &self,
        _: &Admin,
        user: StorageUserAdd,
    ) -> Result<AuthenticatedUser, AppError> {
        self.add_user_no_auth(user).await
    }

    pub async fn add_user_no_auth(
        &self,
        user: StorageUserAdd,
    ) -> Result<AuthenticatedUser, AppError> {
        if user.name.is_empty() {
            return Err(AppError::NameEmpty);
        }

        let user = self.inner.storage.add_user(user).await?;

        Ok(AuthenticatedUser {
            inner: User {
                app: self.new_ref(),
                id: user.id,
                cache_storage: Some(user),
            },
        })
    }

    pub async fn user_by_auth(&self, auth: UserAuth) -> Result<AuthenticatedUser, AppError> {
        match auth {
            UserAuth::None => {
                let user_id = self.config().web_server.default_user_id.map(UserId);
                if let Some(user_id) = user_id {
                    let user = match self.user_by_id(user_id).await {
                        Ok(user) => user,
                        Err(AppError::UserNotFound) => {
                            error!("the default user {user_id:?} was not found!");
                            return Err(AppError::UserNotFound);
                        }
                        Err(err) => return Err(err),
                    };

                    user.authenticate(&UserAuth::None).await
                } else {
                    Err(AppError::Forbidden)
                }
            }
            UserAuth::UserPassword { ref username, .. } => {
                let user = self.user_by_name(username).await?;

                user.authenticate(&auth).await
            }
            UserAuth::Session(session) => {
                let user = self.user_by_session(session).await?;

                Ok(user)
            }
            UserAuth::ForwardedHeaders { username } => {
                let _ = username;
                // TODO: look if config enabled so we can trust or not
                todo!()
            }
        }
    }

    pub async fn user_by_id(&self, user_id: UserId) -> Result<User, AppError> {
        let user = self.inner.storage.get_user(user_id).await?;

        Ok(User {
            app: self.new_ref(),
            id: user_id,
            cache_storage: Some(user),
        })
    }
    pub async fn user_by_name(&self, name: &str) -> Result<User, AppError> {
        let (user_id, user) = self.inner.storage.get_user_by_name(name).await?;

        Ok(User {
            app: self.new_ref(),
            id: user_id,
            cache_storage: user,
        })
    }
    pub async fn user_by_session(
        &self,
        session: SessionToken,
    ) -> Result<AuthenticatedUser, AppError> {
        let (user_id, user) = self
            .inner
            .storage
            .get_user_by_session_token(session)
            .await?;

        Ok(AuthenticatedUser {
            inner: User {
                app: self.new_ref(),
                id: user_id,
                cache_storage: user,
            },
        })
    }

    pub async fn all_users(&self, _: Admin) -> Result<Vec<User>, AppError> {
        let users = self.inner.storage.list_users().await?;

        let users = match users {
            Either::Left(user_ids) => user_ids
                .into_iter()
                .map(|id| User {
                    app: self.new_ref(),
                    id,
                    cache_storage: None,
                })
                .collect::<Vec<_>>(),
            Either::Right(users) => users
                .into_iter()
                .map(|user| User {
                    app: self.new_ref(),
                    id: user.id,
                    cache_storage: Some(user),
                })
                .collect::<Vec<_>>(),
        };

        Ok(users)
    }

    pub async fn delete_session(&self, session: SessionToken) -> Result<(), AppError> {
        self.inner.storage.remove_session_token(session).await
    }
}
