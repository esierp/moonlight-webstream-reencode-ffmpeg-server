use std::{
    sync::{Arc, Weak},
    time::{Duration, Instant},
};

use common::api_bindings::{ReencodeCodec, StatsHostProcessingLatency, StreamerStatsUpdate};
use log::{debug, error, info, warn};
use moonlight_common::stream::{
    bindings::{
        Capabilities, DecodeResult, EstimatedRttInfo, SupportedVideoFormats, VideoDecodeUnit,
        FrameType,
    },
    video::{VideoDecoder, VideoSetup},
};

use crate::{StreamConnection, transport::OutboundPacket};
use crate::ffmpeg::{EncodedPacket, FfmpegPipeline, FfmpegPipelineConfig};
use moonlight_common::stream::bindings::VideoFormat;

pub(crate) struct StreamVideoDecoder {
    pub(crate) stream: Weak<StreamConnection>,
    pub(crate) supported_formats: SupportedVideoFormats,
    pub(crate) stats: VideoStats,
    pub(crate) ffmpeg: Option<FfmpegPipeline>,
    pub(crate) cached_sps: Option<Vec<u8>>,
    pub(crate) cached_pps: Option<Vec<u8>>,
    pub(crate) needs_headers: bool,
    pub(crate) waiting_for_idr: bool,
}

impl StreamVideoDecoder {
    fn cache_parameter_sets(&mut self, annexb: &[u8]) {
        for nal in split_annexb_nals(annexb) {
            if nal.is_empty() {
                continue;
            }

            let nal_type = nal[0] & 0x1f;
            let mut with_start = Vec::with_capacity(nal.len() + 4);
            with_start.extend_from_slice(&[0, 0, 0, 1]);
            with_start.extend_from_slice(nal);

            match nal_type {
                7 => {
                    self.cached_sps = Some(with_start);
                }
                8 => {
                    self.cached_pps = Some(with_start);
                }
                _ => {}
            }
        }
    }

    fn inject_headers_if_needed(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        if !self.needs_headers {
            return Some(frame.to_vec());
        }

        let (sps, pps) = match (self.cached_sps.as_ref(), self.cached_pps.as_ref()) {
            (Some(sps), Some(pps)) => (sps, pps),
            _ => return None,
        };

        let mut merged = Vec::with_capacity(sps.len() + pps.len() + frame.len());
        merged.extend_from_slice(sps);
        merged.extend_from_slice(pps);
        merged.extend_from_slice(frame);
        self.needs_headers = false;
        Some(merged)
    }

    fn frame_has_idr(&self, annexb: &[u8]) -> bool {
        for nal in split_annexb_nals(annexb) {
            if nal.is_empty() {
                continue;
            }

            let nal_type = nal[0] & 0x1f;
            if nal_type == 5 {
                return true;
            }
        }

        false
    }
}

impl VideoDecoder for StreamVideoDecoder {
    fn setup(&mut self, setup: VideoSetup) -> i32 {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to setup video because stream is deallocated");
            return -1;
        };

        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| {
                stream.runtime.clone().block_on(async {
                    let mut stream_info = stream.stream_setup.lock().await;
                    stream_info.video = Some(setup);
                })
            });
        } else {
            stream.runtime.clone().block_on(async {
                let mut stream_info = stream.stream_setup.lock().await;
                stream_info.video = Some(setup);
            });
        }

        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| {
                stream.runtime.clone().block_on(async move {
                    let mut sender = stream.transport_sender.lock().await;

                    if let Some(sender) = sender.as_mut() {
                        sender.setup_video(setup).await
                    } else {
                        error!("Failed to setup video because of missing transport!");
                        -1
                    }
                })
            })
        } else {
            stream.runtime.clone().block_on(async move {
                let mut sender = stream.transport_sender.lock().await;

                if let Some(sender) = sender.as_mut() {
                    sender.setup_video(setup).await
                } else {
                    error!("Failed to setup video because of missing transport!");
                    -1
                }
            })
        }
    }

    fn start(&mut self) {}
    fn stop(&mut self) {}

    fn submit_decode_unit(&mut self, unit: VideoDecodeUnit<'_>) -> DecodeResult {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to send video decode unit because stream is deallocated");
            return DecodeResult::Ok;
        };

        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| {
                stream.runtime.clone().block_on(async {
                    let mut sender = stream.transport_sender.lock().await;

                    if let Some(sender) = sender.as_mut() {
                        let start = Instant::now();

                        let reencode = stream.reencode_settings.lock().await.clone();

                        if let Some(reencode) = reencode.as_ref() {
                            if reencode.enabled {
                                let encoder = match reencode.codec {
                                    ReencodeCodec::H264 => "libx264",
                                    ReencodeCodec::VP8 => "libvpx",
                                };
                                let fps = {
                                    let setup = stream.stream_setup.lock().await;
                                    setup.video.as_ref().map(|v| v.redraw_rate).unwrap_or(60)
                                };

                                let config = FfmpegPipelineConfig {
                                    encoder: encoder.to_string(),
                                    preset: reencode
                                        .preset
                                        .clone()
                                        .unwrap_or_else(|| stream.config.video.ffmpeg.preset.clone()),
                                    bitrate_kbps: reencode.bitrate_kbps,
                                    fps,
                                    threads: reencode.threads,
                                };

                                let needs_rebuild = match self.ffmpeg.as_ref() {
                                    Some(pipeline) => pipeline.config.bitrate_kbps != config.bitrate_kbps
                                        || pipeline.config.encoder != config.encoder
                                        || pipeline.config.fps != config.fps
                                        || pipeline.config.preset != config.preset
                                        || pipeline.config.threads != config.threads,
                                    None => true,
                                };

                                if needs_rebuild {
                                    info!(
                                        "Reencode rebuild (bitrate_kbps={}, preset={}, threads={:?})",
                                        config.bitrate_kbps,
                                        config.preset,
                                        config.threads
                                    );
                                    self.ffmpeg = Some(FfmpegPipeline::new(config));
                                    self.needs_headers = true;
                                    self.waiting_for_idr = true;
                                }
                            } else {
                                self.ffmpeg = None;
                                self.needs_headers = true;
                                self.waiting_for_idr = false;
                            }
                        } else {
                            self.ffmpeg = None;
                            self.needs_headers = true;
                            self.waiting_for_idr = false;
                        }

                        let mut incoming_bytes: u64 = 0;
                        for buffer in unit.buffers.iter() {
                            incoming_bytes = incoming_bytes.saturating_add(buffer.data.len() as u64);
                        }

                        let (result, outgoing_bytes) = if reencode.as_ref().map(|r| r.enabled).unwrap_or(false) {
                            let mut did_transcode = false;
                            let mut outgoing_bytes: u64 = 0;

                            let mut full_frame = Vec::new();
                            for buffer in unit.buffers.iter() {
                                full_frame.extend_from_slice(buffer.data);
                            }

                            self.cache_parameter_sets(&full_frame);
                            let has_idr = self.frame_has_idr(&full_frame)
                                || matches!(unit.frame_type, FrameType::Idr);
                            let mut force_need_idr = false;
                            if self.waiting_for_idr && !has_idr {
                                force_need_idr = true;
                            }
                            if self.waiting_for_idr && has_idr {
                                self.waiting_for_idr = false;
                            }

                            if force_need_idr {
                                (DecodeResult::NeedIdr, 0)
                            } else {
                                let frame_with_headers = self.inject_headers_if_needed(&full_frame);

                                if let Some(pipeline) = self.ffmpeg.as_mut() {
                                    if !pipeline.initialized {
                                        let setup = stream.stream_setup.lock().await;
                                        if let Some(video_setup) = setup.video.as_ref() {
                                            if let Some(input_codec) = map_input_codec(video_setup.format) {
                                                if let Err(err) = pipeline.init_pipeline(
                                                    input_codec,
                                                    video_setup.width,
                                                    video_setup.height,
                                                    pipeline.config.fps.max(1),
                                                ) {
                                                    warn!("Failed to init FFmpeg pipeline: {err}");
                                                }
                                            } else {
                                                warn!("Unsupported input codec for server decode: {:?}", video_setup.format);
                                            }
                                        }
                                    }

                                    if let Some(frame_with_headers) = frame_with_headers {
                                        match pipeline.transcode_annexb(&frame_with_headers) {
                                            Ok(packets) => {
                                                for EncodedPacket { data, keyframe } in packets {
                                                    outgoing_bytes = outgoing_bytes.saturating_add(data.len() as u64);
                                                    if let Err(err) = sender
                                                        .send_h264_annexb(
                                                            &data,
                                                            unit.rtp_timestamp,
                                                            keyframe || matches!(unit.frame_type, FrameType::Idr),
                                                        )
                                                        .await
                                                    {
                                                        warn!("Failed to send transcoded frame: {err}");
                                                    }
                                                }
                                                did_transcode = true;
                                            }
                                            Err(err) => {
                                                warn!("FFmpeg transcode failed: {err}");
                                            }
                                        }
                                    } else {
                                        // Missing SPS/PPS, skip transcode until we have them
                                        did_transcode = false;
                                    }
                                }

                                if !did_transcode {
                                    // Fallback to passthrough if transcode not ready
                                    match sender.send_video_unit(&unit).await {
                                        Err(err) => {
                                            warn!("Failed to send video decode unit: {err}");
                                        }
                                        Ok(_) => {
                                            outgoing_bytes = incoming_bytes;
                                        }
                                    }
                                }

                                (DecodeResult::Ok, outgoing_bytes)
                            }
                        } else {
                            match sender.send_video_unit(&unit).await {
                                Err(err) => {
                                    warn!("Failed to send video decode unit: {err}");
                                    (DecodeResult::Ok, incoming_bytes)
                                }
                                Ok(value) => (value, incoming_bytes),
                            }
                        };

                        let frame_processing_time = Instant::now() - start;
                        self.stats.analyze(&stream, &unit, frame_processing_time, incoming_bytes, outgoing_bytes);

                        result
                    } else {
                        debug!("Dropping video packet because of missing transport");

                        DecodeResult::Ok
                    }
                })
            })
        } else {
            stream.runtime.clone().block_on(async {
                let mut sender = stream.transport_sender.lock().await;

                if let Some(sender) = sender.as_mut() {
                    let start = Instant::now();

                    let reencode = stream.reencode_settings.lock().await.clone();

                    if let Some(reencode) = reencode.as_ref() {
                        if reencode.enabled {
                            let encoder = match reencode.codec {
                                ReencodeCodec::H264 => "libx264",
                                ReencodeCodec::VP8 => "libvpx",
                            };
                            let fps = {
                                let setup = stream.stream_setup.lock().await;
                                setup.video.as_ref().map(|v| v.redraw_rate).unwrap_or(60)
                            };

                            let config = FfmpegPipelineConfig {
                                encoder: encoder.to_string(),
                                preset: reencode
                                    .preset
                                    .clone()
                                    .unwrap_or_else(|| stream.config.video.ffmpeg.preset.clone()),
                                bitrate_kbps: reencode.bitrate_kbps,
                                fps,
                                threads: reencode.threads,
                            };

                            let needs_rebuild = match self.ffmpeg.as_ref() {
                                Some(pipeline) => pipeline.config.bitrate_kbps != config.bitrate_kbps
                                    || pipeline.config.encoder != config.encoder
                                    || pipeline.config.fps != config.fps
                                    || pipeline.config.preset != config.preset
                                    || pipeline.config.threads != config.threads,
                                None => true,
                            };

                            if needs_rebuild {
                                info!(
                                    "Reencode rebuild (bitrate_kbps={}, preset={}, threads={:?})",
                                    config.bitrate_kbps,
                                    config.preset,
                                    config.threads
                                );
                                self.ffmpeg = Some(FfmpegPipeline::new(config));
                                self.needs_headers = true;
                                self.waiting_for_idr = true;
                            }
                        } else {
                            self.ffmpeg = None;
                            self.needs_headers = true;
                            self.waiting_for_idr = false;
                        }
                    } else {
                        self.ffmpeg = None;
                        self.needs_headers = true;
                        self.waiting_for_idr = false;
                    }

                    let mut incoming_bytes: u64 = 0;
                    for buffer in unit.buffers.iter() {
                        incoming_bytes = incoming_bytes.saturating_add(buffer.data.len() as u64);
                    }

                    let (result, outgoing_bytes) = if reencode.as_ref().map(|r| r.enabled).unwrap_or(false) {
                        let mut did_transcode = false;
                        let mut outgoing_bytes: u64 = 0;

                        let mut full_frame = Vec::new();
                        for buffer in unit.buffers.iter() {
                            full_frame.extend_from_slice(buffer.data);
                        }

                        self.cache_parameter_sets(&full_frame);
                        let has_idr = self.frame_has_idr(&full_frame)
                            || matches!(unit.frame_type, FrameType::Idr);
                        let mut force_need_idr = false;
                        if self.waiting_for_idr && !has_idr {
                            force_need_idr = true;
                        }
                        if self.waiting_for_idr && has_idr {
                            self.waiting_for_idr = false;
                        }

                        if force_need_idr {
                            (DecodeResult::NeedIdr, 0)
                        } else {
                            let frame_with_headers = self.inject_headers_if_needed(&full_frame);

                            if let Some(pipeline) = self.ffmpeg.as_mut() {
                                if !pipeline.initialized {
                                    let setup = stream.stream_setup.lock().await;
                                    if let Some(video_setup) = setup.video.as_ref() {
                                        if let Some(input_codec) = map_input_codec(video_setup.format) {
                                            if let Err(err) = pipeline.init_pipeline(
                                                input_codec,
                                                video_setup.width,
                                                video_setup.height,
                                                pipeline.config.fps.max(1),
                                            ) {
                                                warn!("Failed to init FFmpeg pipeline: {err}");
                                            }
                                        } else {
                                            warn!("Unsupported input codec for server decode: {:?}", video_setup.format);
                                        }
                                    }
                                }

                                if let Some(frame_with_headers) = frame_with_headers {
                                    match pipeline.transcode_annexb(&frame_with_headers) {
                                        Ok(packets) => {
                                            for EncodedPacket { data, keyframe } in packets {
                                                outgoing_bytes = outgoing_bytes.saturating_add(data.len() as u64);
                                                if let Err(err) = sender
                                                    .send_h264_annexb(
                                                        &data,
                                                        unit.rtp_timestamp,
                                                        keyframe || matches!(unit.frame_type, FrameType::Idr),
                                                    )
                                                    .await
                                                {
                                                    warn!("Failed to send transcoded frame: {err}");
                                                }
                                            }
                                            did_transcode = true;
                                        }
                                        Err(err) => {
                                            warn!("FFmpeg transcode failed: {err}");
                                        }
                                    }
                                } else {
                                    // Missing SPS/PPS, skip transcode until we have them
                                    did_transcode = false;
                                }
                            }

                            if !did_transcode {
                                // Fallback to passthrough if transcode not ready
                                match sender.send_video_unit(&unit).await {
                                    Err(err) => {
                                        warn!("Failed to send video decode unit: {err}");
                                    }
                                    Ok(_) => {
                                        outgoing_bytes = incoming_bytes;
                                    }
                                }
                            }

                            (DecodeResult::Ok, outgoing_bytes)
                        }
                    } else {
                        match sender.send_video_unit(&unit).await {
                            Err(err) => {
                                warn!("Failed to send video decode unit: {err}");
                                (DecodeResult::Ok, incoming_bytes)
                            }
                            Ok(value) => (value, incoming_bytes),
                        }
                    };

                    let frame_processing_time = Instant::now() - start;
                    self.stats.analyze(&stream, &unit, frame_processing_time, incoming_bytes, outgoing_bytes);

                    result
                } else {
                    debug!("Dropping video packet because of missing transport");

                    DecodeResult::Ok
                }
            })
        }
    }

    fn supported_formats(&self) -> SupportedVideoFormats {
        self.supported_formats
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::empty()
    }
}

fn map_input_codec(format: VideoFormat) -> Option<ffmpeg_next::codec::Id> {
    match format {
        VideoFormat::H264 | VideoFormat::H264High8_444 => Some(ffmpeg_next::codec::Id::H264),
        VideoFormat::H265 | VideoFormat::H265Main10 => Some(ffmpeg_next::codec::Id::HEVC),
        _ => None,
    }
}

fn split_annexb_nals(data: &[u8]) -> Vec<&[u8]> {
    let mut nals = Vec::new();
    let mut i = 0;

    while i + 3 < data.len() {
        let start = if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            i + 3
        } else if i + 4 < data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1 {
            i + 4
        } else {
            i += 1;
            continue;
        };

        let mut end = start;
        while end + 3 < data.len() {
            if data[end] == 0 && data[end + 1] == 0 && (data[end + 2] == 1 || (end + 3 < data.len() && data[end + 2] == 0 && data[end + 3] == 1)) {
                break;
            }
            end += 1;
        }

        if end + 3 >= data.len() {
            end = data.len();
        }

        if start < end && end <= data.len() {
            nals.push(&data[start..end]);
        }

        i = end;
    }

    nals
}

#[derive(Debug, Default)]
pub(crate) struct VideoStats {
    last_send: Option<Instant>,
    min_host_processing_latency: Duration,
    max_host_processing_latency: Duration,
    total_host_processing_latency: Duration,
    host_processing_frame_count: usize,
    min_streamer_processing_time: Duration,
    max_streamer_processing_time: Duration,
    total_streamer_processing_time: Duration,
    streamer_processing_time_frame_count: usize,
    incoming_bytes: u64,
    outgoing_bytes: u64,
    last_bandwidth_sample: Option<Instant>,
}

impl VideoStats {
    fn analyze(
        &mut self,
        stream: &Arc<StreamConnection>,
        unit: &VideoDecodeUnit,
        frame_processing_time: Duration,
        incoming_bytes: u64,
        outgoing_bytes: u64,
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

        self.incoming_bytes = self.incoming_bytes.saturating_add(incoming_bytes);
        self.outgoing_bytes = self.outgoing_bytes.saturating_add(outgoing_bytes);

        let now = Instant::now();

        // Send in 1 sec intervall
        if self
            .last_send
            .map(|last_send| last_send + Duration::from_secs(1) < now)
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

            let bandwidth_interval = self
                .last_bandwidth_sample
                .map(|last| now.saturating_duration_since(last))
                .unwrap_or(Duration::from_secs(1));
            let bandwidth_seconds = bandwidth_interval.as_secs_f64().max(0.001);
            let incoming_kbps = (self.incoming_bytes as f64 * 8.0) / 1000.0 / bandwidth_seconds;
            let outgoing_kbps = (self.outgoing_bytes as f64 * 8.0) / 1000.0 / bandwidth_seconds;

            // Send data
            let runtime = stream.runtime.clone();

            let stream = stream.clone();
            runtime.spawn(async move {
                stream
                    .try_send_packet(
                        OutboundPacket::Stats(StreamerStatsUpdate::Video {
                            host_processing_latency: has_host_processing_latency.then_some(
                                StatsHostProcessingLatency {
                                    min_host_processing_latency_ms: min_host_processing_latency
                                        .as_secs_f64()
                                        * 1000.0,
                                    max_host_processing_latency_ms: max_host_processing_latency
                                        .as_secs_f64()
                                        * 1000.0,
                                    avg_host_processing_latency_ms: avg_host_processing_latency
                                        .as_secs_f64()
                                        * 1000.0,
                                },
                            ),
                            min_streamer_processing_time_ms: min_streamer_processing_time
                                .as_secs_f64()
                                * 1000.0,
                            max_streamer_processing_time_ms: max_streamer_processing_time
                                .as_secs_f64()
                                * 1000.0,
                            avg_streamer_processing_time_ms: avg_streamer_processing_time
                                .as_secs_f64()
                                * 1000.0,
                        }),
                        "host / streamer processing latency",
                        false,
                    )
                    .await;

                stream
                    .try_send_packet(
                        OutboundPacket::Stats(StreamerStatsUpdate::Bandwidth {
                            incoming_kbps,
                            outgoing_kbps,
                        }),
                        "bandwidth",
                        false,
                    )
                    .await;

                // Send RTT info
                let ml_stream_lock = stream.stream.read().await;
                if let Some(ml_stream) = ml_stream_lock.as_ref() {
                    let rtt = ml_stream.estimated_rtt_info();
                    drop(ml_stream_lock);

                    match rtt {
                        Ok(EstimatedRttInfo { rtt, rtt_variance }) => {
                            stream
                                .try_send_packet(
                                    OutboundPacket::Stats(StreamerStatsUpdate::Rtt {
                                        rtt_ms: rtt.as_secs_f64() * 1000.0,
                                        rtt_variance_ms: rtt_variance.as_secs_f64() * 1000.0,
                                    }),
                                    "estimated rtt info",
                                    false,
                                )
                                .await;
                        }
                        Err(err) => {
                            warn!("failed to get estimated rtt info: {err:?}");
                        }
                    };
                }
            });

            // Clear data
            self.min_host_processing_latency = Duration::MAX;
            self.max_host_processing_latency = Duration::ZERO;
            self.total_host_processing_latency = Duration::ZERO;
            self.host_processing_frame_count = 0;
            self.min_streamer_processing_time = Duration::MAX;
            self.max_streamer_processing_time = Duration::ZERO;
            self.total_streamer_processing_time = Duration::ZERO;
            self.streamer_processing_time_frame_count = 0;
            self.incoming_bytes = 0;
            self.outgoing_bytes = 0;

            self.last_send = Some(now);
            self.last_bandwidth_sample = Some(now);
        }
    }
}

