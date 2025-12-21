import { Api } from "../api.js"
import { App, ConnectionStatus, StreamCapabilities, StreamClientMessage, StreamServerMessage, TransportChannelId } from "../api_bindings.js"
import { Component } from "../component/index.js"
import { StreamSettings } from "../component/settings_menu.js"
import { AudioElementPlayer } from "./audio/audio_element.js"
import { AudioPlayer, AudioPlayerSetup } from "./audio/index.js"
import { buildAudioPipeline } from "./audio/pipeline.js"
import { ByteBuffer } from "./buffer.js"
import { defaultStreamInputConfig, StreamInput } from "./input.js"
import { Logger } from "./log.js"
import { StreamStats } from "./stats.js"
import { Transport, TransportShutdown } from "./transport/index.js"
import { WebSocketTransport } from "./transport/web_socket.js"
import { WebRTCTransport } from "./transport/webrtc.js"
import { createSupportedVideoFormatsBits, getSelectedVideoFormat, VideoCodecSupport } from "./video.js"
import { VideoRenderer, VideoRendererSetup } from "./video/index.js"
import { buildVideoPipeline } from "./video/pipeline.js"

export type InfoEvent = CustomEvent<
    { type: "app", app: App } |
    { type: "serverMessage", message: string } |
    { type: "stageStarting" | "stageComplete", stage: string } |
    { type: "stageFailed", stage: string, errorCode: number } |
    { type: "connectionComplete", capabilities: StreamCapabilities } |
    { type: "connectionStatus", status: ConnectionStatus } |
    { type: "connectionTerminated", errorCode: number } |
    { type: "addDebugLine", line: string, additional?: "fatal" | "recover" }
>
export type InfoEventListener = (event: InfoEvent) => void

export function getStreamerSize(settings: StreamSettings, viewerScreenSize: [number, number]): [number, number] {
    let width, height
    if (settings.videoSize == "720p") {
        width = 1280
        height = 720
    } else if (settings.videoSize == "1080p") {
        width = 1920
        height = 1080
    } else if (settings.videoSize == "1440p") {
        width = 2560
        height = 1440
    } else if (settings.videoSize == "4k") {
        width = 3840
        height = 2160
    } else if (settings.videoSize == "custom") {
        width = settings.videoSizeCustom.width
        height = settings.videoSizeCustom.height
    } else { // native
        width = viewerScreenSize[0]
        height = viewerScreenSize[1]
    }
    return [width, height]
}

export class Stream implements Component {
    private logger: Logger = new Logger()

    private api: Api

    private hostId: number
    private appId: number

    private settings: StreamSettings

    private divElement = document.createElement("div")
    private eventTarget = new EventTarget()

    private ws: WebSocket
    private iceServers: Array<RTCIceServer> | null = null

    private videoRenderer: VideoRenderer | null = null
    private audioPlayer: AudioPlayer | null = null

    private input: StreamInput
    private stats: StreamStats

    private streamerSize: [number, number]

    constructor(api: Api, hostId: number, appId: number, settings: StreamSettings, supportedVideoFormats: VideoCodecSupport, viewerScreenSize: [number, number]) {
        this.logger.addInfoListener((info, type) => {
            this.debugLog(info, type ?? undefined)
        })

        this.api = api

        this.hostId = hostId
        this.appId = appId

        this.settings = settings

        this.streamerSize = getStreamerSize(settings, viewerScreenSize)

        // Configure web socket
        const wsApiHost = api.host_url.replace(/^http(s)?:/, "ws$1:")
        // TODO: firstly try out WebTransport
        this.ws = new WebSocket(`${wsApiHost}/host/stream`)
        this.ws.addEventListener("error", this.onError.bind(this))
        this.ws.addEventListener("open", this.onWsOpen.bind(this))
        this.ws.addEventListener("close", this.onWsClose.bind(this))
        this.ws.addEventListener("message", this.onRawWsMessage.bind(this))

        const fps = this.settings.fps

        this.sendWsMessage({
            Init: {
                host_id: this.hostId,
                app_id: this.appId,
                bitrate: this.settings.bitrate,
                packet_size: this.settings.packetSize,
                fps,
                width: this.streamerSize[0],
                height: this.streamerSize[1],
                video_frame_queue_size: this.settings.videoFrameQueueSize,
                play_audio_local: this.settings.playAudioLocal,
                audio_sample_queue_size: this.settings.audioSampleQueueSize,
                video_supported_formats: createSupportedVideoFormatsBits(supportedVideoFormats),
                video_colorspace: "Rec709", // TODO <---
                video_color_range_full: true, // TODO <---
            }
        })

        // Stream Input
        const streamInputConfig = defaultStreamInputConfig()
        Object.assign(streamInputConfig, {
            mouseScrollMode: this.settings.mouseScrollMode,
            controllerConfig: this.settings.controllerConfig
        })
        this.input = new StreamInput(streamInputConfig)

        // Stream Stats
        this.stats = new StreamStats()

        // Dispatch info for next frame so that listeners can be registers
        setTimeout(() => {
            this.debugLog("Requesting Stream with attributes: {")
            // Width, Height, Fps
            this.debugLog(`  Width ${this.streamerSize[0]}`)
            this.debugLog(`  Height ${this.streamerSize[1]}`)
            this.debugLog(`  Fps: ${fps}`)

            // Supported Video Formats
            const supportedVideoFormatsText = []
            for (const item in supportedVideoFormats) {
                if (supportedVideoFormats[item]) {
                    supportedVideoFormatsText.push(item)
                }
            }
            this.debugLog(`  Supported Video Formats: ${createPrettyList(supportedVideoFormatsText)}`)

            this.debugLog("}")
        })
    }

    private debugLog(message: string, type?: "fatal" | "recover") {
        for (const line of message.split("\n")) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "addDebugLine", line, additional: type }
            })

            this.eventTarget.dispatchEvent(event)
        }
    }

    private async onMessage(message: StreamServerMessage) {
        if (typeof message == "string") {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "serverMessage", message }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("StageStarting" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "stageStarting", stage: message.StageStarting.stage }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("StageComplete" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "stageComplete", stage: message.StageComplete.stage }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("StageFailed" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "stageFailed", stage: message.StageFailed.stage, errorCode: message.StageFailed.error_code }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("ConnectionTerminated" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "connectionTerminated", errorCode: message.ConnectionTerminated.error_code }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("UpdateApp" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "app", app: message.UpdateApp.app }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("ConnectionComplete" in message) {
            const capabilities = message.ConnectionComplete.capabilities
            const formatRaw = message.ConnectionComplete.format
            const width = message.ConnectionComplete.width
            const height = message.ConnectionComplete.height
            const fps = message.ConnectionComplete.fps

            const audioChannels = message.ConnectionComplete.audio_channels
            const audioSampleRate = message.ConnectionComplete.audio_sample_rate

            const format = getSelectedVideoFormat(formatRaw)
            if (format == null) {
                this.debugLog(`Video Format ${formatRaw} was not found! Couldn't start stream!`, "fatal")
                return
            }

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "connectionComplete", capabilities }
            })

            this.eventTarget.dispatchEvent(event)

            this.input.onStreamStart(capabilities, [width, height])

            this.stats.setVideoInfo(format ?? "Unknown", width, height, fps)

            const [hasVideo, hasAudio] = await Promise.all([
                this.setupVideo({
                    format,
                    fps,
                    width,
                    height,
                }),
                this.setupAudio({
                    channels: audioChannels,
                    sampleRate: audioSampleRate
                })
            ])

            this.debugLog(`Using video pipeline: ${this.transport?.getChannel(TransportChannelId.HOST_VIDEO).type} (transport) -> ${this.videoRenderer?.implementationName} (renderer)`)
            this.debugLog(`Using audio pipeline: ${this.transport?.getChannel(TransportChannelId.HOST_AUDIO).type} (transport) -> ${this.audioPlayer?.implementationName} (player)`)

            if (!hasVideo || !hasAudio) {
                this.debugLog(`Either audio or video couldn't be setup: Audio ${hasAudio}, Video ${hasVideo}`, "fatal")
            }
        }
        // -- WebRTC Config
        else if ("Setup" in message) {
            const iceServers = message.Setup.ice_servers

            this.iceServers = iceServers

            this.debugLog(`Using WebRTC Ice Servers: ${createPrettyList(
                iceServers.map(server => server.urls).reduce((list, url) => list.concat(url), [])
            )}`)

            await this.startConnection()
        }
        // -- WebRTC
        else if ("WebRtc" in message) {
            const webrtcMessage = message.WebRtc
            if (this.transport instanceof WebRTCTransport) {
                this.transport.onReceiveMessage(webrtcMessage)
            } else {
                this.debugLog(`Received WebRTC message but transport is currently ${this.transport?.implementationName}`)
            }
        }
    }

    async startConnection() {
        this.debugLog(`Using transport: ${this.settings.dataTransport}`)

        if (this.settings.dataTransport == "auto") {
            await this.tryWebRTCTransport()

            // TODO: use Web Socket Transport after WebRTC fail
            // await this.tryWebSocketTransport()
        } else if (this.settings.dataTransport == "webrtc") {
            await this.tryWebRTCTransport()
        } else if (this.settings.dataTransport == "websocket") {
            await this.tryWebSocketTransport()
        }

        this.debugLog("Tried all configured transport options but no connection was possible", "fatal")
    }

    private transport: Transport | null = null

    private setTransport(transport: Transport) {
        if (this.transport) {
            this.transport.close()
        }

        this.transport = transport

        this.input.setTransport(this.transport)
        this.stats.setTransport(this.transport)
    }

    private async tryWebRTCTransport(): Promise<TransportShutdown> {
        this.debugLog("Trying WebRTC transport")

        this.sendWsMessage({
            SetTransport: "WebRTC"
        })

        if (!this.iceServers) {
            this.debugLog(`Failed to try WebRTC Transport: no ice servers available`)
            return "failednoconnect"
        }

        const transport = new WebRTCTransport(this.logger)
        transport.onsendmessage = (message) => this.sendWsMessage({ WebRtc: message })

        transport.initPeer({
            iceServers: this.iceServers
        })
        this.setTransport(transport)

        return new Promise((resolve, reject) => {
            transport.onclose = (shutdown) => {
                resolve(shutdown)
            }
        })
    }
    private async tryWebSocketTransport() {
        this.debugLog("Trying Web Socket transport")

        this.sendWsMessage({
            SetTransport: "WebSocket"
        })

        const transport = new WebSocketTransport(this.ws, new ByteBuffer(100000), this.logger)

        this.setTransport(transport)
    }

    private async setupVideo(setup: VideoRendererSetup): Promise<boolean> {
        if (this.videoRenderer) {
            this.debugLog("Found an old video renderer -> cleaning it up")

            this.videoRenderer.unmount(this.divElement)
            this.videoRenderer.cleanup()
            this.videoRenderer = null
        }
        if (!this.transport) {
            this.debugLog("Failed to setup video without transport")
            return false
        }

        await this.transport.setupHostVideo({
            type: ["videotrack", "data"]
        })

        const video = this.transport.getChannel(TransportChannelId.HOST_VIDEO)
        if (video.type == "videotrack") {
            const { videoRenderer, error } = buildVideoPipeline("videotrack", this.settings, this.logger)

            if (error) {
                return false
            }

            videoRenderer.mount(this.divElement)

            videoRenderer.setup(setup)
            video.addTrackListener((track) => videoRenderer.setTrack(track))

            this.videoRenderer = videoRenderer
        } else if (video.type == "data") {
            const { videoRenderer, error } = buildVideoPipeline("data", this.settings, this.logger)

            if (error) {
                return false
            }

            videoRenderer.mount(this.divElement)

            videoRenderer.setup(setup)

            video.addReceiveListener((data) => {
                videoRenderer.submitPacket(data)
            })

            this.videoRenderer = videoRenderer
        } else {
            this.debugLog(`Failed to create video pipeline with transport channel of type ${video.type} (${this.transport.implementationName})`)
            return false
        }

        return true
    }
    private async setupAudio(setup: AudioPlayerSetup): Promise<boolean> {
        if (this.audioPlayer) {
            this.debugLog("Found an old audio player -> cleaning it up")

            this.audioPlayer.unmount(this.divElement)
            this.audioPlayer.cleanup()
            this.audioPlayer = null
        }
        if (!this.transport) {
            this.debugLog("Failed to setup audio without transport")
            return false
        }

        this.transport.setupHostAudio({
            type: ["audiotrack", "data"]
        })

        const audio = this.transport?.getChannel(TransportChannelId.HOST_AUDIO)
        if (audio.type == "audiotrack") {
            const { audioPlayer, error } = buildAudioPipeline("audiotrack", this.settings)

            if (error) {
                return false
            }

            audioPlayer.mount(this.divElement)

            audioPlayer.setup(setup)
            audio.addTrackListener((track) => audioPlayer.setTrack(track))

            this.audioPlayer = audioPlayer
        } else if (audio.type == "data") {
            const { audioPlayer, error } = buildAudioPipeline("data", this.settings)

            if (error) {
                return false
            }

            audioPlayer.mount(this.divElement)

            audioPlayer.setup(setup)

            audio.addReceiveListener((data) => {
                audioPlayer.decodeAndPlay({
                    // TODO: fill in duration and timestamp
                    durationMicroseconds: 0,
                    timestampMicroseconds: 0,
                    data
                })
            })

            this.audioPlayer = audioPlayer
        } else {
            this.debugLog(`Cannot find audio pipeline for transport type "${audio.type}"`)
            return false
        }

        return true
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }

    getVideoRenderer(): VideoRenderer | null {
        return this.videoRenderer
    }
    getAudioPlayer(): AudioPlayer | null {
        return this.audioPlayer
    }

    // -- Raw Web Socket stuff
    private wsSendBuffer: Array<string> = []

    private onWsOpen() {
        this.debugLog(`Web Socket Open`)

        for (const raw of this.wsSendBuffer.splice(0)) {
            this.ws.send(raw)
        }
    }
    private onWsClose() {
        this.debugLog(`Web Socket Closed`)
    }
    private onError(event: Event) {
        this.debugLog(`Web Socket or WebRtcPeer Error`)

        console.error(`Web Socket or WebRtcPeer Error`, event)
    }

    private sendWsMessage(message: StreamClientMessage) {
        const raw = JSON.stringify(message)
        if (this.ws.readyState == WebSocket.OPEN) {
            this.ws.send(raw)
        } else {
            this.wsSendBuffer.push(raw)
        }
    }
    private onRawWsMessage(event: MessageEvent) {
        const message = event.data
        if (typeof message == "string") {
            const json = JSON.parse(message)

            this.onMessage(json)
        }
    }

    // -- Class Api
    addInfoListener(listener: InfoEventListener) {
        this.eventTarget.addEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }
    removeInfoListener(listener: InfoEventListener) {
        this.eventTarget.removeEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }

    getInput(): StreamInput {
        return this.input
    }
    getStats(): StreamStats {
        return this.stats
    }

    getStreamerSize(): [number, number] {
        return this.streamerSize
    }
}

function createPrettyList(list: Array<string>): string {
    let isFirst = true
    let text = "["
    for (const item of list) {
        if (!isFirst) {
            text += ", "
        }
        isFirst = false

        text += item
    }
    text += "]"

    return text
}