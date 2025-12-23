import { StreamSupportedVideoFormats } from "../api_bindings.js"

export type VideoCodecSupport = {
    H264: boolean
    H264_HIGH8_444: boolean
    H265: boolean
    H265_MAIN10: boolean
    H265_REXT8_444: boolean
    H265_REXT10_444: boolean
    AV1_MAIN8: boolean
    AV1_MAIN10: boolean
    AV1_HIGH8_444: boolean
    AV1_HIGH10_444: boolean
} & Record<string, boolean>

const CAPABILITIES_CODECS: Array<{ key: string, mimeType: string, fmtpLine: Array<string> }> = [
    // H264
    { key: "H264", mimeType: "video/H264", fmtpLine: ["packetization-mode=1", "profile-level-id=42e01f"] },
    { key: "H264_HIGH8_444", mimeType: "video/H264", fmtpLine: ["packetization-mode=1", "profile-level-id=640032"] },
    // H265
    // TODO: check level id in check function
    { key: "H265", mimeType: "video/H265", fmtpLine: [] }, // <-- Safari H265 fmtpLine is empty (for some dumb reason)
    { key: "H265_MAIN10", mimeType: "video/H265", fmtpLine: ["profile-id=2", "tier-flag=0", "tx-mode=SRST"] },
    { key: "H265_REXT8_444", mimeType: "video/H265", fmtpLine: ["profile-id=4", "tier-flag=0", "tx-mode=SRST"] },
    { key: "H265_REXT10_444", mimeType: "video/H265", fmtpLine: ["profile-id=5", "tier-flag=0", "tx-mode=SRST"] },
    // Av1
    { key: "AV1_MAIN8", mimeType: "video/AV1", fmtpLine: [] }, // <-- Safari AV1 fmtpLine is empty
    { key: "AV1_MAIN10", mimeType: "video/AV1", fmtpLine: [] }, // <-- Safari AV1 fmtpLine is empty
    { key: "AV1_HIGH8", mimeType: "video/AV1", fmtpLine: ["profile=1"] },
    { key: "AV1_HIGH10", mimeType: "video/AV1", fmtpLine: ["profile=1"] },
]

export const VIDEO_DECODER_CODECS: Array<{ key: string } & VideoDecoderConfig> = [
    { key: "H264", codec: "avc1.42E01E", colorSpace: { primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: true }, hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
    { key: "H264_HIGH8_444", codec: "avc1.4d400c", colorSpace: { primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: true }, hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
    { key: "H265", codec: "hvc1.1.6.L93.B0", hardwareAcceleration: "prefer-hardware" },
    { key: "H265_MAIN10", codec: "hvc1.2.4.L120.90", hardwareAcceleration: "prefer-hardware" },
    { key: "H265_REXT8_444", codec: "hvc1.6.6.L93.90", colorSpace: { primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: true }, hardwareAcceleration: "prefer-hardware" },
    { key: "H265_REXT10_444", codec: "hvc1.6.10.L120.90", colorSpace: { primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: true }, hardwareAcceleration: "prefer-hardware" },
    { key: "AV1_MAIN8", codec: "av01.0.04M.08", hardwareAcceleration: "prefer-hardware" },
    { key: "AV1_MAIN10", codec: "av01.0.04M.10", hardwareAcceleration: "prefer-hardware" },
    { key: "AV1_HIGH8_444", codec: "av01.0.08M.08", colorSpace: { primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: true }, hardwareAcceleration: "prefer-hardware" },
    { key: "AV1_HIGH10_444", codec: "av01.0.08M.10", colorSpace: { primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: true }, hardwareAcceleration: "prefer-hardware" }
]

export function emptyVideoFormats(): VideoCodecSupport {
    return {
        H264: false,
        H264_HIGH8_444: false,
        H265: false,
        H265_MAIN10: false,
        H265_REXT8_444: false,
        H265_REXT10_444: false,
        AV1_MAIN8: false,
        AV1_MAIN10: false,
        AV1_HIGH8_444: false,
        AV1_HIGH10_444: false
    }
}

export function hasAnyCodec(codecs: VideoCodecSupport): boolean {
    for (const key in codecs) {
        if (codecs[key]) {
            return true
        }
    }

    return false
}

export async function getSupportedVideoFormats(): Promise<VideoCodecSupport> {
    // TODO: this function is kinda misleading for the server, there are multiple transports which support different codecs -> seperate the codecs into the supported codecs per transport
    // TODO: maybe use the pipes / renderers to get the video codecs and only send the pipes + video codec combo's that we can play to the server

    let support: VideoCodecSupport = emptyVideoFormats()

    let capabilities = null
    if ("getCapabilities" in RTCRtpReceiver && typeof RTCRtpReceiver.getCapabilities == "function" && (capabilities = RTCRtpReceiver.getCapabilities("video"))) {
        for (const capCodec of capabilities.codecs) {
            for (const codec of CAPABILITIES_CODECS) {
                let compatible = true

                if (capCodec.mimeType.toLowerCase() != codec.mimeType.toLowerCase()) {
                    compatible = false
                }
                for (const fmtpLineAttrib of codec.fmtpLine) {
                    if (!capCodec.sdpFmtpLine?.includes(fmtpLineAttrib)) {
                        compatible = false
                    }
                }

                if (compatible) {
                    support[codec.key] = true
                }
            }
        }
    } else if ("VideoDecoder" in window) {
        for (const codec of VIDEO_DECODER_CODECS) {
            try {
                const result = await VideoDecoder.isConfigSupported(codec)

                support[codec.key] = result.supported ?? support[codec.key]
            } catch (e) {
                support[codec.key] = false
            }
        }
    } else if ("MediaSource" in window) {
        for (const codec of VIDEO_DECODER_CODECS) {
            const supported = MediaSource.isTypeSupported(`video/mp4; codecs="${codec.codec}"`)

            support[codec.key] = supported || support[codec.key]
        }
    } else {
        const mediaElement = document.createElement("video")

        for (const codec of VIDEO_DECODER_CODECS) {
            const supported = mediaElement.canPlayType(`video/mp4; codecs="${codec.codec}"`)

            support[codec.key] = supported == "probably" || support[codec.key]
        }
    }

    return support
}

export function createSupportedVideoFormatsBits(support: VideoCodecSupport): number {
    let mask = 0

    if (support.H264) {
        mask |= StreamSupportedVideoFormats.H264
    }
    if (support.H264_HIGH8_444) {
        mask |= StreamSupportedVideoFormats.H264_HIGH8_444
    }
    if (support.H265) {
        mask |= StreamSupportedVideoFormats.H265
    }
    if (support.H265_MAIN10) {
        mask |= StreamSupportedVideoFormats.H265_MAIN10
    }
    if (support.H265_REXT8_444) {
        mask |= StreamSupportedVideoFormats.H265_REXT8_444
    }
    if (support.H265_REXT10_444) {
        mask |= StreamSupportedVideoFormats.H265_REXT10_444
    }
    if (support.AV1_MAIN8) {
        mask |= StreamSupportedVideoFormats.AV1_MAIN8
    }
    if (support.AV1_MAIN10) {
        mask |= StreamSupportedVideoFormats.AV1_MAIN10
    }
    if (support.AV1_HIGH8_444) {
        mask |= StreamSupportedVideoFormats.AV1_HIGH8_444
    }
    if (support.AV1_HIGH10_444) {
        mask |= StreamSupportedVideoFormats.AV1_HIGH10_444
    }

    return mask
}
export function getSelectedVideoFormat(videoFormat: number): keyof typeof StreamSupportedVideoFormats | null {
    if (videoFormat == StreamSupportedVideoFormats.H264) {
        return "H264"
    } else if (videoFormat == StreamSupportedVideoFormats.H264_HIGH8_444) {
        return "H264_HIGH8_444"
    } else if (videoFormat == StreamSupportedVideoFormats.H265) {
        return "H265"
    } else if (videoFormat == StreamSupportedVideoFormats.H265_MAIN10) {
        return "H265_MAIN10"
    } else if (videoFormat == StreamSupportedVideoFormats.H265_REXT8_444) {
        return "H265_REXT8_444"
    } else if (videoFormat == StreamSupportedVideoFormats.H265_REXT10_444) {
        return "H265_REXT10_444"
    } else if (videoFormat == StreamSupportedVideoFormats.AV1_MAIN8) {
        return "AV1_MAIN8"
    } else if (videoFormat == StreamSupportedVideoFormats.AV1_MAIN10) {
        return "AV1_MAIN10"
    } else if (videoFormat == StreamSupportedVideoFormats.AV1_HIGH8_444) {
        return "AV1_HIGH8_444"
    } else if (videoFormat == StreamSupportedVideoFormats.AV1_HIGH10_444) {
        return "AV1_HIGH10_444"
    } else {
        return null
    }
}