import { StreamerStatsUpdate } from "../api_bindings.js"
import { showErrorPopup } from "../component/error.js"

export type StreamStatsData = {
    videoCodec: string | null
    decoderImplementation: string | null
    videoWidth: number | null
    videoHeight: number | null
    videoFps: number | null
    webrtcFps: number | null
    streamerRttMs: number | null
    streamerRttVarianceMs: number | null
    minHostProcessingLatencyMs: number | null
    maxHostProcessingLatencyMs: number | null
    avgHostProcessingLatencyMs: number | null
    minStreamerProcessingTimeMs: number | null
    maxStreamerProcessingTimeMs: number | null
    avgStreamerProcessingTimeMs: number | null
    webrtcJitterMs: number | null
    webrtcJitterBufferDelayMs: number | null
    webrtcJitterBufferTargetDelayMs: number | null
    webrtcJitterBufferMinimumDelayMs: number | null
    webrtcTotalAssemblyTime: number | null
    webrtcTotalDecodeTime: number | null
    webrtcTotalProcessingDelayMs: number | null
    webrtcPacketsReceived: number | null,
    webrtcPacketsLost: number | null
    webrtcFramesDropped: number | null
    webrtcKeyFramesDecoded: number | null
}

function num(value: number | null, suffix?: string): string | null {
    if (value == null) {
        return null
    } else {
        return `${value.toFixed(2)}${suffix ?? ""}`
    }
}

export function streamStatsToText(statsData: StreamStatsData): string {
    return `stats:
video information: ${statsData.videoCodec}${statsData.decoderImplementation ? ` (${statsData.decoderImplementation})` : ""}, ${statsData.videoWidth}x${statsData.videoHeight}, ${statsData.videoFps} fps
streamer round trip time: ${num(statsData.streamerRttMs, "ms")} (variance: ${num(statsData.streamerRttVarianceMs, "ms")})
host processing latency min/max/avg: ${num(statsData.minHostProcessingLatencyMs, "ms")} / ${num(statsData.maxHostProcessingLatencyMs, "ms")} / ${num(statsData.avgHostProcessingLatencyMs, "ms")}
streamer processing latency min/max/avg: ${num(statsData.minStreamerProcessingTimeMs, "ms")} / ${num(statsData.maxStreamerProcessingTimeMs, "ms")} / ${num(statsData.avgStreamerProcessingTimeMs, "ms")}
webrtc fps: ${num(statsData.webrtcFps)}
webrtc jitter: ${num(statsData.webrtcJitterMs, "ms")}
webrtc jitter buffer delay normal/target/min: ${num(statsData.webrtcJitterBufferDelayMs, "ms")} / ${num(statsData.webrtcJitterBufferTargetDelayMs, "ms")} / ${num(statsData.webrtcJitterBufferMinimumDelayMs, "ms")}
webrtc total decode time: ${num(statsData.webrtcTotalDecodeTime, "ms")}
webrtc total assembly time: ${num(statsData.webrtcTotalAssemblyTime, "ms")}
webrtc total processing delay: ${num(statsData.webrtcTotalProcessingDelayMs, "ms")}
webrtc packets received/lost: ${num(statsData.webrtcPacketsReceived)} / ${num(statsData.webrtcPacketsLost)}
webrtc frames dropped: ${num(statsData.webrtcFramesDropped)}
webrtc key frames decoded: ${num(statsData.webrtcKeyFramesDecoded)}
`
}

export class StreamStats {

    private enabled: boolean = false
    private peer: RTCPeerConnection | null = null
    private statsChannel: RTCDataChannel | null = null
    private updateIntervalId: number | null = null
    private videoReceiver: RTCRtpReceiver | null = null

    private statsData: StreamStatsData = {
        videoCodec: null,
        decoderImplementation: null,
        videoWidth: null,
        videoHeight: null,
        videoFps: null,
        webrtcFps: null,
        streamerRttMs: null,
        streamerRttVarianceMs: null,
        minHostProcessingLatencyMs: null,
        maxHostProcessingLatencyMs: null,
        avgHostProcessingLatencyMs: null,
        minStreamerProcessingTimeMs: null,
        maxStreamerProcessingTimeMs: null,
        avgStreamerProcessingTimeMs: null,
        webrtcJitterMs: null,
        webrtcJitterBufferDelayMs: null,
        webrtcJitterBufferTargetDelayMs: null,
        webrtcJitterBufferMinimumDelayMs: null,
        webrtcTotalAssemblyTime: null,
        webrtcTotalDecodeTime: null,
        webrtcTotalProcessingDelayMs: null,
        webrtcPacketsReceived: null,
        webrtcPacketsLost: null,
        webrtcFramesDropped: null,
        webrtcKeyFramesDecoded: null,
    }

    constructor(peer?: RTCPeerConnection) {
        if (peer) {
            this.setPeer(peer)
        }
    }

    setPeer(peer: RTCPeerConnection) {
        this.peer = peer

        this.checkEnabled()
    }
    private checkEnabled() {
        if (this.enabled) {
            if (!this.statsChannel && this.peer) {
                this.statsChannel = this.peer.createDataChannel("stats")
                this.statsChannel.onmessage = this.onRawMessage.bind(this)
            }
            if (this.updateIntervalId == null) {
                this.updateIntervalId = setInterval(this.updateLocalStats.bind(this), 1000)
            }
        } else {
            if (this.updateIntervalId != null) {
                clearInterval(this.updateIntervalId)
                this.updateIntervalId = null
            }
        }
    }

    setEnabled(enabled: boolean) {
        this.enabled = enabled

        this.checkEnabled()
    }
    isEnabled(): boolean {
        return this.enabled
    }
    toggle() {
        this.setEnabled(!this.isEnabled())
    }

    private onRawMessage(event: MessageEvent) {
        const msg = event.data
        if (typeof msg != "string") {
            showErrorPopup("Cannot decode stats: not send as string")
            return;
        }
        const json: StreamerStatsUpdate = JSON.parse(msg)

        this.onMessage(json)
    }
    private onMessage(msg: StreamerStatsUpdate) {
        if ("Rtt" in msg) {
            this.statsData.streamerRttMs = msg.Rtt.rtt_ms
            this.statsData.streamerRttVarianceMs = msg.Rtt.rtt_variance_ms
        } else if ("Video" in msg) {
            if (msg.Video.host_processing_latency) {
                this.statsData.minHostProcessingLatencyMs = msg.Video.host_processing_latency.min_host_processing_latency_ms
                this.statsData.maxHostProcessingLatencyMs = msg.Video.host_processing_latency.max_host_processing_latency_ms
                this.statsData.avgHostProcessingLatencyMs = msg.Video.host_processing_latency.avg_host_processing_latency_ms
            } else {
                this.statsData.minHostProcessingLatencyMs = null
                this.statsData.maxHostProcessingLatencyMs = null
                this.statsData.avgHostProcessingLatencyMs = null
            }

            this.statsData.minStreamerProcessingTimeMs = msg.Video.min_streamer_processing_time_ms
            this.statsData.maxStreamerProcessingTimeMs = msg.Video.max_streamer_processing_time_ms
            this.statsData.avgStreamerProcessingTimeMs = msg.Video.avg_streamer_processing_time_ms
        }
    }

    private async updateLocalStats() {
        if (!this.videoReceiver) {
            return
        }

        const stats = await this.videoReceiver.getStats()
        for (const [_, value] of stats) {
            if (value.type != "inbound-rtp") {
                continue
            }

            if ("decoderImplementation" in value && value.decoderImplementation != null) {
                this.statsData.decoderImplementation = value.decoderImplementation
            }
            if ("frameWidth" in value && value.frameWidth != null) {
                this.statsData.videoWidth = value.frameWidth
            }
            if ("frameHeight" in value && value.frameHeight != null) {
                this.statsData.videoHeight = value.frameHeight
            }
            if ("framesPerSecond" in value && value.framesPerSecond != null) {
                this.statsData.webrtcFps = value.framesPerSecond
            }

            if ("jitterBufferDelay" in value && value.jitterBufferDelay != null) {
                this.statsData.webrtcJitterBufferDelayMs = value.jitterBufferDelay
            }
            if ("jitterBufferTargetDelay" in value && value.jitterBufferTargetDelay != null) {
                this.statsData.webrtcJitterBufferTargetDelayMs = value.jitterBufferTargetDelay
            }
            if ("jitterBufferMinimumDelay" in value && value.jitterBufferMinimumDelay != null) {
                this.statsData.webrtcJitterBufferMinimumDelayMs = value.jitterBufferMinimumDelay
            }
            if ("jitter" in value && value.jitter != null) {
                this.statsData.webrtcJitterMs = value.jitter
            }
            if ("totalDecodeTime" in value && value.totalDecodeTime != null) {
                this.statsData.webrtcTotalDecodeTime = value.totalDecodeTime
            }
            if ("totalAssemblyTime" in value && value.totalAssemblyTime != null) {
                this.statsData.webrtcTotalAssemblyTime = value.totalAssemblyTime
            }
            if ("totalProcessingDelay" in value && value.totalProcessingDelay != null) {
                this.statsData.webrtcTotalProcessingDelayMs = value.totalProcessingDelay
            }
            if ("packetsReceived" in value && value.packetsReceived != null) {
                this.statsData.webrtcPacketsReceived = value.packetsReceived
            }
            if ("packetsLost" in value && value.packetsLost != null) {
                this.statsData.webrtcPacketsLost = value.packetsLost
            }
            if ("framesDropped" in value && value.framesDropped != null) {
                this.statsData.webrtcFramesDropped = value.framesDropped
            }
            if ("keyFramesDecoded" in value && value.keyFramesDecoded != null) {
                this.statsData.webrtcKeyFramesDecoded = value.keyFramesDecoded
            }
        }
    }

    setVideoReceiver(videoReceiver: RTCRtpReceiver) {
        this.videoReceiver = videoReceiver
    }
    setVideoInfo(codec: string, width: number, height: number, fps: number) {
        this.statsData.videoCodec = codec
        this.statsData.videoWidth = width
        this.statsData.videoHeight = height
        this.statsData.videoFps = fps
    }

    getCurrentStats(): StreamStatsData {
        const data = {}
        Object.assign(data, this.statsData)
        return data as StreamStatsData
    }
}