//! FFmpeg decode/encode pipeline (PoC scaffold)
//!
//! TODO (PoC):
//! - Initialize decoder based on incoming codec (H.264/HEVC)
//! - Decode NALs into raw frames (YUV420)
//! - Encode to H.264 (libx264) with config presets
//! - Provide Annex-B NALs for WebRTC RTP

use ffmpeg_next as ffmpeg;
use ffmpeg_next::Dictionary;

#[derive(Debug, Clone)]
pub struct FfmpegPipelineConfig {
    pub encoder: String,
    pub preset: String,
    pub bitrate_kbps: u32,
    pub fps: u32,
    pub threads: Option<u16>,
}

#[derive(Debug)]
pub struct EncodedPacket {
    pub data: Vec<u8>,
    pub keyframe: bool,
}

pub struct FfmpegPipeline {
    pub config: FfmpegPipelineConfig,
    pub initialized: bool,
    decoder: Option<ffmpeg::codec::decoder::Video>,
    encoder: Option<ffmpeg::codec::encoder::Video>,
    frame: ffmpeg::util::frame::Video,
    packet: ffmpeg::Packet,
    pts: i64,
}

impl FfmpegPipeline {
    pub fn new(config: FfmpegPipelineConfig) -> Self {
        Self {
            config,
            initialized: false,
            decoder: None,
            encoder: None,
            frame: ffmpeg::util::frame::Video::empty(),
            packet: ffmpeg::Packet::empty(),
            pts: 0,
        }
    }

    pub fn init(&mut self) -> Result<(), ffmpeg::Error> {
        if !self.initialized {
            ffmpeg::init()?;
            self.initialized = true;
        }
        Ok(())
    }

    pub fn init_pipeline(
        &mut self,
        input_codec: ffmpeg::codec::Id,
        width: u32,
        height: u32,
        fps: u32,
    ) -> Result<(), ffmpeg::Error> {
        self.init()?;

        let decoder_codec = ffmpeg::codec::decoder::find(input_codec)
            .ok_or(ffmpeg::Error::DecoderNotFound)?;
        let decoder_ctx = ffmpeg::codec::context::Context::new_with_codec(decoder_codec);
        let decoder = decoder_ctx.decoder().video()?;

        let encoder_codec = ffmpeg::codec::encoder::find_by_name(&self.config.encoder)
            .ok_or(ffmpeg::Error::EncoderNotFound)?;
        let mut encoder_video = ffmpeg::codec::context::Context::new_with_codec(encoder_codec)
            .encoder()
            .video()?;
        encoder_video.set_width(width);
        encoder_video.set_height(height);
        encoder_video.set_format(ffmpeg::format::Pixel::YUV420P);
        encoder_video.set_bit_rate((self.config.bitrate_kbps as usize) * 1000);
        encoder_video.set_time_base((1, fps as i32));
        encoder_video.set_frame_rate(Some((fps as i32, 1)));
        encoder_video.set_gop(fps.max(1));
        encoder_video.set_max_b_frames(0);

        if let Some(threads) = self.config.threads {
            if threads > 0 {
                encoder_video.set_threading(ffmpeg::codec::threading::Config {
                    kind: ffmpeg::codec::threading::Type::Frame,
                    count: threads as usize,
                    ..Default::default()
                });
            }
        }

        let mut opts = Dictionary::new();
        opts.set("preset", &self.config.preset);
        opts.set("tune", "zerolatency");
        opts.set("profile", "baseline");
        opts.set("repeat-headers", "1");

        let encoder = encoder_video.open_as_with(encoder_codec, opts)?;

        self.decoder = Some(decoder);
        self.encoder = Some(encoder);
        Ok(())
    }

    /// Accepts Annex-B H.264/HEVC NALs and returns Annex-B H.264 NALs.
    pub fn transcode_annexb(
        &mut self,
        nal_annexb: &[u8],
    ) -> Result<Vec<EncodedPacket>, ffmpeg::Error> {
        let decoder = self.decoder.as_mut().ok_or(ffmpeg::Error::Bug)?;
        let encoder = self.encoder.as_mut().ok_or(ffmpeg::Error::Bug)?;

        let mut out = Vec::new();

        self.packet = ffmpeg::Packet::copy(nal_annexb);
        decoder.send_packet(&self.packet)?;

        while decoder.receive_frame(&mut self.frame).is_ok() {
            self.frame.set_pts(Some(self.pts));
            self.pts += 1;

            encoder.send_frame(&self.frame)?;
            let mut encoded = ffmpeg::Packet::empty();
            while encoder.receive_packet(&mut encoded).is_ok() {
                out.push(EncodedPacket {
                    data: encoded.data().unwrap_or(&[]).to_vec(),
                    keyframe: encoded.is_key(),
                });
            }
        }

        Ok(out)
    }
}
