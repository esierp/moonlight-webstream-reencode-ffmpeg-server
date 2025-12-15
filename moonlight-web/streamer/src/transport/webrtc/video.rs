use std::{
    io::Cursor,
    ops::Range,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use bytes::{Bytes, BytesMut};
use common::api_bindings::{StatsHostProcessingLatency, StreamerStatsUpdate};
use log::{debug, error, info, warn};
use moonlight_common::stream::{
    bindings::{
        DecodeResult, EstimatedRttInfo, FrameType, SupportedVideoFormats, VideoDecodeUnit,
        VideoFormat,
    },
    video::{PullVideoManager, VideoSetup},
};
use webrtc::{
    api::media_engine::{MIME_TYPE_AV1, MIME_TYPE_H264, MIME_TYPE_HEVC, MediaEngine},
    rtcp::payload_feedbacks::{
        picture_loss_indication::PictureLossIndication,
        receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate,
    },
    rtp::{
        codecs::{av1::Av1Payloader, h264::H264Payloader, h265::RTP_OUTBOUND_MTU},
        header::Header,
        packet::Packet,
        packetizer::Payloader,
    },
    rtp_transceiver::{
        RTCPFeedback,
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
    },
    track::track_local::track_local_static_rtp::TrackLocalStaticRTP,
};

use crate::{
    StreamConnection,
    transport::webrtc::{
        WebRtcInner,
        sender::{SequencedTrackLocalStaticRTP, TrackLocalSender},
        video::{
            annexb::AnnexBSplitter,
            h264::reader::H264Reader,
            h265::{payloader::H265Payloader, reader::H265Reader},
        },
    },
};

mod annexb;
mod h264;
mod h265;

enum VideoCodec {
    H264 {
        nal_reader: H264Reader<Cursor<Vec<u8>>>,
        payloader: H264Payloader,
    },
    H265 {
        nal_reader: H265Reader<Cursor<Vec<u8>>>,
        payloader: H265Payloader,
    },
    Av1 {
        annex_b: AnnexBSplitter<Cursor<Vec<u8>>>,
        payloader: Av1Payloader,
    },
}

pub struct WebRtcVideo {
    supported_video_formats: SupportedVideoFormats,
    sender: TrackLocalSender<SequencedTrackLocalStaticRTP>,
    needs_idr: Arc<AtomicBool>,
    clock_rate: u32,
    codec: Option<VideoCodec>,
    samples: Vec<BytesMut>,
}

impl WebRtcVideo {
    pub fn new(
        inner: Weak<WebRtcInner>,
        supported_video_formats: SupportedVideoFormats,
        frame_queue_size: usize,
    ) -> Self {
        Self {
            clock_rate: 0,
            needs_idr: Default::default(),
            sender: TrackLocalSender::new(inner, frame_queue_size),
            codec: None,
            supported_video_formats,
            samples: Default::default(),
        }
    }

    pub async fn setup(
        &mut self,
        VideoSetup {
            format,
            width,
            height,
            redraw_rate,
            flags: _,
        }: VideoSetup,
    ) -> bool {
        info!("[Stream] Stream setup: {width}x{height}x{redraw_rate} and {format:?}");

        if !format.contained_in(self.supported_video_formats) {
            error!(
                "tried to setup a video stream with a non supported video format: {format:?}, supported formats: {:?}",
                self.supported_video_formats
                    .iter_names()
                    .collect::<Vec<_>>()
            );
            return false;
        }

        let Some(codec) = video_format_to_codec(format) else {
            error!("Failed to get video codec with format {:?}", format);
            return false;
        };

        let needs_idr = self.needs_idr.clone();
        if let Err(err) = self
            .sender
            .create_track(
                TrackLocalStaticRTP::new(
                    codec.capability.clone(),
                    "video".to_string(),
                    "moonlight".to_string(),
                )
                .into(),
                {
                    let needs_idr = needs_idr.clone();

                    move |packet| {
                        let packet = packet.as_any();

                        if packet.is::<PictureLossIndication>() {
                            needs_idr.store(true, Ordering::Release);
                        }
                        if let Some(_max_bitrate) =
                            packet.downcast_ref::<ReceiverEstimatedMaximumBitrate>()
                        {
                            // Moonlight doesn't support dynamic bitrate changing :(
                        }
                    }
                },
            )
            .await
        {
            error!(
                "Failed to create video track with format {format:?} and codec \"{codec:?}\": {err:?}"
            );
            return false;
        }

        self.clock_rate = codec.capability.clock_rate;

        self.codec = match format {
            // -- H264
            VideoFormat::H264 | VideoFormat::H264High8_444 => Some(VideoCodec::H264 {
                nal_reader: H264Reader::new(Cursor::new(Vec::new()), 0),
                payloader: Default::default(),
            }),
            // -- H265
            VideoFormat::H265
            | VideoFormat::H265Main10
            | VideoFormat::H265Rext8_444
            | VideoFormat::H265Rext10_444 => Some(VideoCodec::H265 {
                nal_reader: H265Reader::new(Cursor::new(Vec::new()), 0),
                payloader: Default::default(),
            }),
            // -- AV1
            VideoFormat::Av1Main8
            | VideoFormat::Av1Main10
            | VideoFormat::Av1High8_444
            | VideoFormat::Av1High10_444 => Some(VideoCodec::Av1 {
                annex_b: AnnexBSplitter::new(Cursor::new(Vec::new()), 0),
                payloader: Default::default(),
            }),
        };

        // Renegotiate
        let inner = self.sender.inner.upgrade().unwrap();
        inner
            .runtime
            .clone()
            .spawn(async move { inner.send_offer().await });

        true
    }

    pub async fn send_decode_unit(&mut self, unit: &VideoDecodeUnit<'_>) -> DecodeResult {
        let start_frame = Instant::now();

        let timestamp = (unit.presentation_time.as_secs_f64() * self.clock_rate as f64) as u32;

        let mut full_frame = Vec::new();
        for buffer in unit.buffers {
            full_frame.extend_from_slice(buffer.data);
        }

        let important = matches!(unit.frame_type, FrameType::Idr);

        match &mut self.codec {
            // -- H264
            Some(VideoCodec::H264 {
                nal_reader,
                payloader,
            }) => {
                nal_reader.reset(Cursor::new(full_frame));

                while let Ok(Some(nal)) = nal_reader.next_nal() {
                    let data = trim_bytes_to_range(
                        nal.full,
                        nal.header_range.start..nal.payload_range.end,
                    );

                    self.samples.push(data);
                }

                send_single_frame(
                    &mut self.samples,
                    &mut self.sender,
                    payloader,
                    timestamp,
                    important,
                    &self.needs_idr,
                )
                .await;
            }
            // -- H265
            Some(VideoCodec::H265 {
                nal_reader,
                payloader,
            }) => {
                nal_reader.reset(Cursor::new(full_frame));

                while let Ok(Some(nal)) = nal_reader.next_nal() {
                    let data = trim_bytes_to_range(
                        nal.full,
                        nal.header_range.start..nal.payload_range.end,
                    );

                    self.samples.push(data);
                }

                send_single_frame(
                    &mut self.samples,
                    &mut self.sender,
                    payloader,
                    timestamp,
                    important,
                    &self.needs_idr,
                )
                .await;
            }
            // -- AV1
            Some(VideoCodec::Av1 { annex_b, payloader }) => {
                annex_b.reset(Cursor::new(full_frame));

                while let Ok(Some(annex_b_payload)) = annex_b.next() {
                    let data =
                        trim_bytes_to_range(annex_b_payload.full, annex_b_payload.payload_range);

                    self.samples.push(data);
                }

                send_single_frame(
                    &mut self.samples,
                    &mut self.sender,
                    payloader,
                    timestamp,
                    important,
                    &self.needs_idr,
                )
                .await;
            }
            None => {
                warn!("Failed to send decode unit because of missing codec!");
            }
        }

        if self
            .needs_idr
            .compare_exchange_weak(true, false, Ordering::SeqCst, Ordering::Relaxed)
            .is_ok()
        {
            return DecodeResult::NeedIdr;
        }

        // TODO
        let frame_processing_time = Instant::now() - start_frame;
        // stats.analyze(stream.clone(), &unit, frame_processing_time);

        DecodeResult::Ok
    }
}

pub fn register_video_codecs(
    media_engine: &mut MediaEngine,
    supported_video_formats: SupportedVideoFormats,
) -> Result<(), webrtc::Error> {
    for format in VideoFormat::all() {
        if !format.contained_in(supported_video_formats) {
            continue;
        }

        let Some(codec) = video_format_to_codec(format) else {
            continue;
        };
        debug!(
            "Registering Video Format {format:?}, Codec: {:?}",
            codec.capability
        );

        media_engine.register_codec(codec, RTPCodecType::Video)?;
    }

    Ok(())
}

async fn send_single_frame(
    samples: &mut Vec<BytesMut>,
    sender: &mut TrackLocalSender<SequencedTrackLocalStaticRTP>,
    payloader: &mut impl Payloader,
    timestamp: u32,
    important: bool,
    needs_idr: &AtomicBool,
) {
    if important {
        sender.clear_queue(false).await;
    }

    let mut peekable = samples.drain(..).peekable();

    let mut frame_samples = Vec::new();
    while let Some(sample) = peekable.next() {
        let packets = match packetize(
            payloader,
            RTP_OUTBOUND_MTU,
            0, // is set in the write fn
            timestamp,
            &sample.freeze(),
            peekable.peek().is_none(),
        ) {
            Ok(value) => value,
            Err(err) => {
                warn!("failed to packetize packet: {err:?}");
                continue;
            }
        };

        frame_samples.extend(packets);
    }

    if !sender.send_samples(frame_samples, important).await {
        sender.clear_queue(true).await;

        // We've dropped a frame (likely due to buffering)
        needs_idr.store(true, Ordering::Release);
    }
}

fn packetize(
    payloader: &mut impl Payloader,
    mtu: usize,
    sequence_number: u16,
    timestamp: u32,
    payload: &Bytes,
    end_has_marker: bool,
) -> Result<Vec<Packet>, anyhow::Error> {
    let payloads = payloader.payload(mtu - 12, payload)?;
    let payloads_len = payloads.len();
    let mut packets = Vec::with_capacity(payloads_len);
    for (i, payload) in payloads.into_iter().enumerate() {
        packets.push(Packet {
            header: Header {
                version: 2,
                padding: false,
                extension: false,
                marker: end_has_marker && i == payloads_len - 1,
                sequence_number,
                timestamp,
                payload_type: 0, // Value is handled when writing
                ssrc: 0,         // Value is handled when writing
                ..Default::default()
            },
            payload,
        });
    }

    Ok(packets)
}

fn video_format_to_codec(format: VideoFormat) -> Option<RTCRtpCodecParameters> {
    let rtcp_feedback = vec![
        RTCPFeedback {
            typ: "nack".to_string(),
            parameter: "".to_string(),
        },
        RTCPFeedback {
            typ: "nack".to_string(),
            parameter: "pli".to_string(),
        },
        RTCPFeedback {
            typ: "goog-remb".to_string(),
            parameter: "".to_string(),
        },
    ];

    match format {
        // -- H264 Constrained Baseline Profile
        VideoFormat::H264 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line:
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                        .to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 96,
            ..Default::default()
        }),
        // -- H264 High Profile
        VideoFormat::H264High8_444 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line:
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032"
                        .to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 97,
            ..Default::default()
        }),

        // TODO: h265 requires resolution in the level-id field, set it based on resolution and fps
        // -- H265 Main Profile
        VideoFormat::H265 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_HEVC.to_owned(),
                clock_rate: 90000,
                channels: 0,
                // They're the same
                // sdp_fmtp_line: "profile-id=1;level-id=93;tier-flag=0;tx-mode=1".to_owned(),
                sdp_fmtp_line: "".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 98,
            ..Default::default()
        }),
        // -- H265 Main10 Profile
        VideoFormat::H265Main10 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_HEVC.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile-id=2;tier-flag=0;level-id=93;tx-mode=SRST".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 99,
            ..Default::default()
        }),
        // -- H265 RExt 4:4:4 8-bit
        VideoFormat::H265Rext8_444 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_HEVC.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile-id=4;tier-flag=0;level-id=120;tx-mode=SRST".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 100,
            ..Default::default()
        }),
        // -- H265 RExt 4:4:4 10-bit
        VideoFormat::H265Rext10_444 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_HEVC.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile-id=5;tier-flag=0;level-id=93;tx-mode=SRST".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 101,
            ..Default::default()
        }),

        // -- Av1
        VideoFormat::Av1Main8 | VideoFormat::Av1Main10 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_AV1.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile=0".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 102,
            ..Default::default()
        }),
        VideoFormat::Av1High8_444 | VideoFormat::Av1High10_444 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_AV1.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile=1".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 103,
            ..Default::default()
        }),
    }
}

fn trim_bytes_to_range(mut buf: BytesMut, range: Range<usize>) -> BytesMut {
    if range.start > 0 {
        let _ = buf.split_to(range.start);
    }

    if range.end - range.start < buf.len() {
        let _ = buf.split_off(range.end - range.start);
    }

    buf
}

#[derive(Debug, Default)]
struct VideoStats {
    last_send: Option<Instant>,
    min_host_processing_latency: Duration,
    max_host_processing_latency: Duration,
    total_host_processing_latency: Duration,
    host_processing_frame_count: usize,
    min_streamer_processing_time: Duration,
    max_streamer_processing_time: Duration,
    total_streamer_processing_time: Duration,
    streamer_processing_time_frame_count: usize,
}

impl VideoStats {
    fn analyze(
        &mut self,
        stream: Arc<StreamConnection>,
        unit: &VideoDecodeUnit,
        frame_processing_time: Duration,
    ) {
        if let Some(host_processing_latency) = unit.frame_processing_latency {
            self.min_host_processing_latency = self
                .min_host_processing_latency
                .min(host_processing_latency);
            self.max_host_processing_latency = self
                .max_host_processing_latency
                .max(host_processing_latency);
            self.total_host_processing_latency += host_processing_latency;
            self.host_processing_frame_count += 1;
        }

        self.min_streamer_processing_time =
            self.min_streamer_processing_time.min(frame_processing_time);
        self.max_streamer_processing_time =
            self.max_streamer_processing_time.max(frame_processing_time);
        self.total_streamer_processing_time += frame_processing_time;
        self.streamer_processing_time_frame_count += 1;

        // Send in 1 sec intervall
        if self
            .last_send
            .map(|last_send| last_send + Duration::from_secs(1) < Instant::now())
            .unwrap_or(true)
        {
            // Collect data
            let has_host_processing_latency = self.host_processing_frame_count > 0;
            let min_host_processing_latency = self.min_host_processing_latency;
            let max_host_processing_latency = self.max_host_processing_latency;
            let avg_host_processing_latency = self
                .total_host_processing_latency
                .checked_div(self.host_processing_frame_count as u32)
                .unwrap_or(Duration::ZERO);

            let min_streamer_processing_time = self.min_streamer_processing_time;
            let max_streamer_processing_time = self.max_streamer_processing_time;
            let avg_streamer_processing_time = self
                .total_streamer_processing_time
                .checked_div(self.streamer_processing_time_frame_count as u32)
                .unwrap_or(Duration::ZERO);

            // TODO
            // Send data
            // let runtime = stream.runtime.clone();
            // runtime.spawn(async move {
            //     // Send Video info
            //     stream
            //         .send_stats(StreamerStatsUpdate::Video {
            //             host_processing_latency: has_host_processing_latency.then_some(
            //                 StatsHostProcessingLatency {
            //                     min_host_processing_latency_ms: min_host_processing_latency
            //                         .as_secs_f64()
            //                         * 1000.0,
            //                     max_host_processing_latency_ms: max_host_processing_latency
            //                         .as_secs_f64()
            //                         * 1000.0,
            //                     avg_host_processing_latency_ms: avg_host_processing_latency
            //                         .as_secs_f64()
            //                         * 1000.0,
            //                 },
            //             ),
            //             min_streamer_processing_time_ms: min_streamer_processing_time.as_secs_f64()
            //                 * 1000.0,
            //             max_streamer_processing_time_ms: max_streamer_processing_time.as_secs_f64()
            //                 * 1000.0,
            //             avg_streamer_processing_time_ms: avg_streamer_processing_time.as_secs_f64()
            //                 * 1000.0,
            //         })
            //         .await;

            //     // Send RTT info
            //     let ml_stream = stream.stream.read().await;
            //     if let Some(ml_stream) = ml_stream.as_ref() {
            //         match ml_stream.estimated_rtt_info() {
            //             Ok(EstimatedRttInfo { rtt, rtt_variance }) => {
            //                 stream
            //                     .send_stats(StreamerStatsUpdate::Rtt {
            //                         rtt_ms: rtt.as_secs_f64() * 1000.0,
            //                         rtt_variance_ms: rtt_variance.as_secs_f64() * 1000.0,
            //                     })
            //                     .await;
            //             }
            //             Err(err) => {
            //                 warn!("failed to get estimated rtt info: {err:?}");
            //             }
            //         };
            //     }
            // });

            // Clear data
            self.min_host_processing_latency = Duration::MAX;
            self.max_host_processing_latency = Duration::ZERO;
            self.total_host_processing_latency = Duration::ZERO;
            self.host_processing_frame_count = 0;
            self.min_streamer_processing_time = Duration::MAX;
            self.max_streamer_processing_time = Duration::ZERO;
            self.total_streamer_processing_time = Duration::ZERO;
            self.streamer_processing_time_frame_count = 0;

            self.last_send = Some(Instant::now());
        }
    }
}
