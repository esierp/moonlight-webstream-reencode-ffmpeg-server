use common::config::Config;
use openssl::ssl::{SslAcceptor, SslFiletype, SslMethod};
use std::{io::ErrorKind, path::Path};
use tokio::fs::{self, File};

use actix_web::{
    App as ActixApp, HttpServer,
    middleware::{self, Logger},
    web::{Data, scope},
};
use log::{Level, error, info};
use serde::{Serialize, de::DeserializeOwned};
use simplelog::{ColorChoice, CombinedLogger, SharedLogger, TermLogger, TerminalMode, WriteLogger};

use crate::{
    api::api_service,
    app::App,
    human_json::preprocess_human_json,
    web::{web_config_js_service, web_service},
};

mod api;
mod app;
mod web;

mod human_json;

#[actix_web::main]
async fn main() {
    // Load Config
    let config = read_or_default::<Config>("./server/config.json", true).await;

    // TODO: log config: anonymize ips when enabled in file
    // TODO: https://www.reddit.com/r/csharp/comments/166xgcl/comment/jynybpe/

    // TODO: set config via environment variables or cli flags in docker container?

    let mut log_config = simplelog::ConfigBuilder::default();

    let mut loggers: Vec<Box<dyn SharedLogger>> = vec![TermLogger::new(
        config.log.level_filter,
        log_config.build(),
        TerminalMode::Mixed,
        ColorChoice::Auto,
    )];

    if let Some(file_path) = &config.log.file_path {
        if fs::try_exists(file_path)
            .await
            .expect("failed to check if log file exists")
        {
            // TODO: should we rename?
        }

        let file = File::create(file_path)
            .await
            .expect("failed to open log file");

        loggers.push(WriteLogger::new(
            config.log.level_filter,
            log_config.build(),
            file.try_into_std()
                .expect("failed to cast tokio file into std file"),
        ));
    }

    CombinedLogger::init(loggers).expect("failed to init combined logger");

    if let Err(err) = start(config).await {
        error!("{err:?}");
    }
}

async fn start(config: Config) -> Result<(), anyhow::Error> {
    let app = App::new(config.clone()).await?;
    let app = Data::new(app);

    let bind_address = app.config().web_server.bind_address;
    let server = HttpServer::new({
        let url_path_prefix = config.web_server.url_path_prefix.clone();
        let app = app.clone();

        move || {
            ActixApp::new().service(
                scope(&url_path_prefix)
                    .app_data(app.clone())
                    .wrap(
                        Logger::new("%r took %D ms")
                            .log_target("http_server")
                            .log_level(Level::Debug),
                    )
                    .wrap(
                        // TODO: maybe only re cache when required?
                        middleware::DefaultHeaders::new()
                            .add((
                                "Cache-Control",
                                "no-store, no-cache, must-revalidate, private",
                            ))
                            .add(("Pragma", "no-cache"))
                            .add(("Expires", "0")),
                    )
                    .service(api_service())
                    .service(web_config_js_service())
                    .service(web_service()),
            )
        }
    });

    if let Some(certificate) = app.config().web_server.certificate.as_ref() {
        info!("[Server]: Running Https Server with ssl tls");

        let mut builder = SslAcceptor::mozilla_intermediate(SslMethod::tls())
            .expect("failed to create ssl tls acceptor");
        builder
            .set_private_key_file(&certificate.private_key_pem, SslFiletype::PEM)
            .expect("failed to set private key");
        builder
            .set_certificate_chain_file(&certificate.certificate_pem)
            .expect("failed to set certificate");

        server.bind_openssl(bind_address, builder)?.run().await?;
    } else {
        server.bind(bind_address)?.run().await?;
    }

    Ok(())
}

async fn read_or_default<T>(path: impl AsRef<Path>, hjson: bool) -> T
where
    T: DeserializeOwned + Serialize + Default,
{
    match fs::read_to_string(path.as_ref()).await {
        Ok(mut value) => {
            if hjson {
                value = preprocess_human_json(value);
            }

            serde_json::from_str(&value).expect("invalid file")
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            let value = T::default();

            let value_str = serde_json::to_string_pretty(&value).expect("failed to serialize file");

            if let Some(parent) = path.as_ref().parent() {
                fs::create_dir_all(parent)
                    .await
                    .expect("failed to create directories to file");
            }
            fs::write(path.as_ref(), value_str)
                .await
                .expect("failed to write default file");

            value
        }
        Err(err) => panic!("failed to read file: {err}"),
    }
}
