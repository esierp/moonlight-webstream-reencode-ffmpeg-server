import { StreamerStatsUpdate, TransportChannelId } from "../api_bindings.js"
import { BIG_BUFFER, ByteBuffer } from "./buffer.js"
import { Logger } from "./log.js"
import { Pipe } from "./pipeline/index.js"
import { DataTransportChannel, Transport } from "./transport/index.js"

export type StatValue = string | number

export type StreamStatsData = {
    videoCodec: string | null
    videoWidth: number | null
    videoHeight: number | null
    videoFps: number | null
    videoPipeline: string | null
    audioPipeline: string | null
    hdrEnabled: boolean | null
    transcodeEnabled: boolean | null
    transcodeCodec: string | null
    transcodeBitrateKbps: number | null
    streamerRttMs: number | null
    streamerRttVarianceMs: number | null
    minHostProcessingLatencyMs: number | null
    maxHostProcessingLatencyMs: number | null
    avgHostProcessingLatencyMs: number | null
    minStreamerProcessingTimeMs: number | null
    maxStreamerProcessingTimeMs: number | null
    avgStreamerProcessingTimeMs: number | null
    browserRtt: number | null
    incomingKbps: number | null
    outgoingKbps: number | null
    clientTargetBitrateKbps: number | null
    adaptiveEnabled: boolean | null
    adaptiveMinKbps: number | null
    adaptiveMaxKbps: number | null
    transport: Record<string, StatValue>
    video: Record<string, StatValue>
    audio: Record<string, StatValue>
}

function num(value: number | null | undefined, suffix?: string): string | null {
    if (value == null) {
        return null
    } else {
        return `${value.toFixed(2)}${suffix ?? ""}`
    }
}

export function streamStatsToText(statsData: StreamStatsData): string {
    let text = `stats:
video information: ${statsData.videoCodec}, ${statsData.videoWidth}x${statsData.videoHeight}, ${statsData.videoFps} fps
HDR: ${statsData.hdrEnabled === true ? "Enabled" : statsData.hdrEnabled === false ? "Disabled" : "Unknown"}
server transcode: ${statsData.transcodeEnabled === true ? "On" : statsData.transcodeEnabled === false ? "Off" : "Unknown"} ${statsData.transcodeCodec ? `(${statsData.transcodeCodec})` : ""} ${statsData.transcodeBitrateKbps ? `${statsData.transcodeBitrateKbps} kbps` : ""}
client target bitrate: ${num(statsData.clientTargetBitrateKbps, " kbps")}
adaptive re-encode: ${statsData.adaptiveEnabled === true ? "On" : statsData.adaptiveEnabled === false ? "Off" : "Unknown"} ${statsData.adaptiveMinKbps != null && statsData.adaptiveMaxKbps != null ? `(min ${statsData.adaptiveMinKbps} / max ${statsData.adaptiveMaxKbps} kbps)` : ""}
video pipeline: ${statsData.videoPipeline}
audio pipeline: ${statsData.audioPipeline}
streamer round trip time: ${num(statsData.streamerRttMs, "ms")} (variance: ${num(statsData.streamerRttVarianceMs, "ms")})
host processing latency min/max/avg: ${num(statsData.minHostProcessingLatencyMs, "ms")} / ${num(statsData.maxHostProcessingLatencyMs, "ms")} / ${num(statsData.avgHostProcessingLatencyMs, "ms")}
streamer processing latency min/max/avg: ${num(statsData.minStreamerProcessingTimeMs, "ms")} / ${num(statsData.maxStreamerProcessingTimeMs, "ms")} / ${num(statsData.avgStreamerProcessingTimeMs, "ms")}
moonlight → streamer: ${num(statsData.incomingKbps, " kbps")}
streamer → browser: ${num(statsData.outgoingKbps, " kbps")}
streamer to browser rtt (ws only): ${num(statsData.browserRtt, "ms")}
`
    for (const key in statsData.transport) {
        const value = statsData.transport[key]
        let valuePretty = value

        if (typeof value == "number" && key.endsWith("Ms")) {
            valuePretty = `${num(value, "ms")}`
        }

        text += `${key}: ${valuePretty}\n`
    }

    for (const key in statsData.video) {
        const value = statsData.video[key]
        let valuePretty = value

        if (typeof value == "number" && key.endsWith("Ms")) {
            valuePretty = `${num(value, "ms")}`
        }

        text += `${key}: ${valuePretty}\n`
    }

    for (const key in statsData.audio) {
        const value = statsData.audio[key]
        let valuePretty = value

        if (typeof value == "number" && key.endsWith("Ms")) {
            valuePretty = `${num(value, "ms")}`
        }

        text += `${key}: ${valuePretty}\n`
    }

    return text
}

export class StreamStats {

    private logger: Logger | null = null

    private enabled: boolean = false
    private transport: Transport | null = null
    private statsChannel: DataTransportChannel | null = null
    private updateIntervalId: number | null = null

    private videoPipe: Pipe | null = null
    private audioPipe: Pipe | null = null
    private statsData: StreamStatsData = {
        videoCodec: null,
        videoWidth: null,
        videoHeight: null,
        videoFps: null,
        videoPipeline: null,
        audioPipeline: null,
        hdrEnabled: null,
        transcodeEnabled: null,
        transcodeCodec: null,
        transcodeBitrateKbps: null,
        streamerRttMs: null,
        streamerRttVarianceMs: null,
        minHostProcessingLatencyMs: null,
        maxHostProcessingLatencyMs: null,
        avgHostProcessingLatencyMs: null,
        minStreamerProcessingTimeMs: null,
        maxStreamerProcessingTimeMs: null,
        avgStreamerProcessingTimeMs: null,
        browserRtt: null,
        incomingKbps: null,
        outgoingKbps: null,
        clientTargetBitrateKbps: null,
        adaptiveEnabled: null,
        adaptiveMinKbps: null,
        adaptiveMaxKbps: null,
        transport: {},
        video: {},
        audio: {}
    }

    constructor(logger?: Logger) {
        if (logger) {
            this.logger = logger
        }
    }

    setTransport(transport: Transport) {
        this.transport = transport

        this.checkEnabled()
    }
    private checkEnabled() {
        if (this.enabled) {
            if (this.statsChannel) {
                this.statsChannel.removeReceiveListener(this.onRawData.bind(this))
                this.statsChannel = null
            }

            if (!this.statsChannel && this.transport) {
                const channel = this.transport.getChannel(TransportChannelId.STATS)
                if (channel.type != "data") {
                    this.logger?.debug(`Failed initialize debug transport channel because type is "${channel.type}" and not "data"`)
                    return
                }
                channel.addReceiveListener(this.onRawData.bind(this))
                this.statsChannel = channel
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

    private buffer: ByteBuffer = BIG_BUFFER
    private onRawData(data: ArrayBuffer) {
        this.buffer.reset()
        this.buffer.putU8Array(new Uint8Array(data))

        this.buffer.flip()

        const textLength = this.buffer.getU16()
        const text = this.buffer.getUtf8Raw(textLength)

        const json: StreamerStatsUpdate = JSON.parse(text)
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
        } else if ("BrowserRtt" in msg) {
            this.statsData.browserRtt = msg.BrowserRtt.rtt_ms
        } else if ("Bandwidth" in msg) {
            this.statsData.incomingKbps = msg.Bandwidth.incoming_kbps
            this.statsData.outgoingKbps = msg.Bandwidth.outgoing_kbps
        }
    }

    private async updateLocalStats() {
        Promise.all([
            this.updateTransportStats(),
            this.updateVideoStats(),
            this.updateAudioStats(),
        ])
    }
    private async updateTransportStats() {
        if (!this.transport) {
            console.debug("Cannot query stats without transport")
            return
        }

        const stats = await this.transport?.getStats()
        for (const key in stats) {
            const value = stats[key]

            this.statsData.transport[key] = value
        }
    }
    private async updateVideoStats() {
        const stats = {}

        if (this.videoPipe && this.videoPipe.reportStats) {
            this.videoPipe.reportStats(stats)
        }

        this.statsData.video = stats
    }
    private async updateAudioStats() {
        const stats = {}

        if (this.audioPipe && this.audioPipe.reportStats) {
            this.audioPipe.reportStats(stats)
        }

        this.statsData.audio = stats
    }

    setVideoInfo(codec: string, width: number, height: number, fps: number) {
        this.statsData.videoCodec = codec
        this.statsData.videoWidth = width
        this.statsData.videoHeight = height
        this.statsData.videoFps = fps
    }
    setVideoPipeline(name: string, pipe: Pipe | null) {
        this.statsData.videoPipeline = name
        this.videoPipe = pipe
    }
    setAudioPipeline(name: string, pipe: Pipe | null) {
        this.statsData.audioPipeline = name
        this.audioPipe = pipe
    }
    setHdrEnabled(enabled: boolean) {
        this.statsData.hdrEnabled = enabled
    }
    setTranscodeInfo(enabled: boolean, codec: string | null, bitrateKbps: number | null) {
        this.statsData.transcodeEnabled = enabled
        this.statsData.transcodeCodec = codec
        this.statsData.transcodeBitrateKbps = bitrateKbps
    }
    setClientTargetBitrateKbps(bitrateKbps: number | null) {
        this.statsData.clientTargetBitrateKbps = bitrateKbps
    }
    setAdaptiveBitrateConfig(enabled: boolean, minKbps: number, maxKbps: number) {
        this.statsData.adaptiveEnabled = enabled
        this.statsData.adaptiveMinKbps = minKbps
        this.statsData.adaptiveMaxKbps = maxKbps
    }

    getCurrentStats(): StreamStatsData {
        const data = {}
        Object.assign(data, this.statsData)
        return data as StreamStatsData
    }
}
