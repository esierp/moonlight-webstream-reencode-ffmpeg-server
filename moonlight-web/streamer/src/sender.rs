use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use log::{debug, warn};
use tokio::sync::{
    Mutex,
    mpsc::{Receiver, Sender, channel, error::TrySendError},
};
use webrtc::{
    media::Sample,
    rtcp::packet::Packet,
    rtp::{
        self,
        extension::{
            HeaderExtension, abs_send_time_extension::AbsSendTimeExtension,
            playout_delay_extension::PlayoutDelayExtension,
        },
    },
    track::track_local::{
        TrackLocal, track_local_static_rtp::TrackLocalStaticRTP,
        track_local_static_sample::TrackLocalStaticSample,
    },
};

use crate::StreamConnection;

pub struct TrackLocalSender<Track>
where
    Track: TrackLike,
{
    channel_queue_size: usize,
    pub(crate) stream: Arc<StreamConnection>,
    sender: Option<Sender<Track::Sample>>,
}

impl<Track> TrackLocalSender<Track>
where
    Track: TrackLike,
{
    pub fn new(stream: Arc<StreamConnection>, channel_queue_size: usize) -> Self {
        Self {
            channel_queue_size,
            stream,
            sender: Default::default(),
        }
    }

    pub fn blocking_create_track(
        &mut self,
        track: Track,
        mut on_packet: impl FnMut(Box<dyn Packet + Send + Sync>) + Send + 'static,
    ) -> Result<(), anyhow::Error> {
        let stream = self.stream.clone();

        let track = Arc::new(track);

        let (sender, receiver) = channel(self.channel_queue_size);

        self.stream.runtime.spawn({
            let track = track.clone();
            async move {
                sample_sender(track, receiver).await;
            }
        });

        let track_sender = self.stream.runtime.block_on({
            let track = track.clone();
            async move { stream.peer.add_track(track.track()).await }
        })?;

        // Read incoming RTCP packets
        // Before these packets are returned they are processed by interceptors. For things
        // like NACK this needs to be called.
        self.stream.runtime.spawn(async move {
            let mut rtcp_buf = vec![0u8; 1500];
            while let Ok((packets, _)) = track_sender.read(&mut rtcp_buf).await {
                for packet in packets {
                    on_packet(packet);
                }
            }
        });

        self.sender.replace(sender);

        Ok(())
    }

    /// Returns if the frame will be delivered
    pub fn send_sample(&self, sample: Track::Sample, important: bool) -> Result<bool, ()> {
        if let Some(sender) = self.sender.as_ref() {
            if important {
                let _ = sender.blocking_send(sample);

                return Ok(true);
            } else {
                return match sender.try_send(sample) {
                    Ok(()) => Ok(true),
                    Err(TrySendError::Full(_)) => {
                        debug!("dropping sample on purpose because queue is full");
                        Ok(false)
                    }
                    Err(TrySendError::Closed(_)) => Err(()),
                };
            }
        }

        Err(())
    }
}

async fn sample_sender<Track>(track: Arc<Track>, mut receiver: Receiver<Track::Sample>)
where
    Track: TrackLike,
{
    while let Some(sample) = receiver.recv().await {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock went backwards");
        let now_secs = now.as_secs() as f64 + now.subsec_nanos() as f64 * 1e-9;
        let abs_send_time: u64 = (now_secs * 262_144.0) as u64;

        if let Err(err) = track
            .write_with_extensions(
                sample,
                &[
                    HeaderExtension::PlayoutDelay(PlayoutDelayExtension::new(0, 0)),
                    HeaderExtension::AbsSendTime(AbsSendTimeExtension {
                        timestamp: abs_send_time,
                    }),
                ],
            )
            .await
        {
            warn!("[Stream]: track.write_sample failed: {err}");
        }
    }
}

pub trait TrackLike: Send + Sync + 'static {
    type Sample: Send + 'static;

    fn write_with_extensions(
        &self,
        sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> impl Future<Output = Result<(), anyhow::Error>> + Send;

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static>;
}

impl TrackLike for TrackLocalStaticSample {
    type Sample = Sample;

    async fn write_with_extensions(
        &self,
        sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> Result<(), anyhow::Error> {
        self.write_sample_with_extensions(&sample, extensions)
            .await
            .map_err(anyhow::Error::from)
    }

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static> {
        self
    }
}

pub struct SequencedTrackLocalStaticRTP {
    track: Arc<TrackLocalStaticRTP>,
    sequence_number: Mutex<u16>,
}

impl From<TrackLocalStaticRTP> for SequencedTrackLocalStaticRTP {
    fn from(value: TrackLocalStaticRTP) -> Self {
        Self {
            track: Arc::new(value),
            sequence_number: Mutex::new(0),
        }
    }
}

impl TrackLike for SequencedTrackLocalStaticRTP {
    type Sample = rtp::packet::Packet;

    async fn write_with_extensions(
        &self,
        mut sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> Result<(), anyhow::Error> {
        let (any_paused, all_paused) = (
            self.track.any_binding_paused().await,
            self.track.all_binding_paused().await,
        );

        if all_paused {
            // Abort already here to not increment sequence numbers.
            return Ok(());
        }
        if any_paused {
            // TODO: maybe warn?
        }

        let mut sequence_number = self.sequence_number.lock().await;
        sample.header.sequence_number = *sequence_number;
        *sequence_number = sequence_number.wrapping_add(1);

        self.track
            .write_rtp_with_extensions(&sample, extensions)
            .await
            .map_err(anyhow::Error::from)
            .map(|_| ())
    }

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static> {
        self.track.clone()
    }
}
