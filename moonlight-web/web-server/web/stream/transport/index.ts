import { TransportChannelId } from "../../api_bindings.js"

export type TransportChannelIdKey = keyof typeof TransportChannelId
export type TransportChannelIdValue = typeof TransportChannelId[TransportChannelIdKey]

export type TransportVideoType = "videotrack" // TrackTransportChannel
    | "data" // Data like https://github.com/moonlight-stream/moonlight-common-c/blob/b126e481a195fdc7152d211def17190e3434bcce/src/Limelight.h#L298


export type TransportVideoSetup = {
    // List containing all supported types, priority highest=0, lowest=biggest index
    type: Array<TransportVideoType>
}

export type TransportAudioType = "audiotrack" // TrackTransportChannel
    | "data" // Data like https://github.com/moonlight-stream/moonlight-common-c/blob/b126e481a195fdc7152d211def17190e3434bcce/src/Limelight.h#L356


export type TransportAudioSetup = {
    // List containing all supported types, priority highest=0, lowest=biggest index
    type: Array<TransportAudioType>
}

// TOOD: common transport channel types: e.g. reliable / unreliable, ordered usw
export type TransportChannelOption = {
    ordered: boolean
    reliable: boolean
}
export const TRANSPORT_CHANNEL_OPTIONS: Record<keyof typeof TransportChannelId, TransportChannelOption> = {
    GENERAL: { reliable: true, ordered: true },
    STATS: { reliable: true, ordered: true },
    HOST_VIDEO: { reliable: false, ordered: true },
    HOST_AUDIO: { reliable: false, ordered: true },
    MOUSE_RELIABLE: { reliable: true, ordered: true },
    MOUSE_ABSOLUTE: { reliable: false, ordered: true },
    MOUSE_RELATIVE: { reliable: true, ordered: false },
    KEYBOARD: { reliable: true, ordered: true },
    TOUCH: { reliable: true, ordered: true },
    CONTROLLERS: { reliable: true, ordered: true },
    CONTROLLER0: { reliable: false, ordered: true },
    CONTROLLER1: { reliable: false, ordered: true },
    CONTROLLER2: { reliable: false, ordered: true },
    CONTROLLER3: { reliable: false, ordered: true },
    CONTROLLER4: { reliable: false, ordered: true },
    CONTROLLER5: { reliable: false, ordered: true },
    CONTROLLER6: { reliable: false, ordered: true },
    CONTROLLER7: { reliable: false, ordered: true },
    CONTROLLER8: { reliable: false, ordered: true },
    CONTROLLER9: { reliable: false, ordered: true },
    CONTROLLER10: { reliable: false, ordered: true },
    CONTROLLER11: { reliable: false, ordered: true },
    CONTROLLER12: { reliable: false, ordered: true },
    CONTROLLER13: { reliable: false, ordered: true },
    CONTROLLER14: { reliable: false, ordered: true },
    CONTROLLER15: { reliable: false, ordered: true },
}

export type TransportShutdown = "failednoconnect" | "failed" | "disconnect"

export interface Transport {
    readonly implementationName: string

    onconnected: (() => void) | null
    ondisconnected: (() => void) | null

    getChannel(id: TransportChannelIdValue): TransportChannel

    setupHostVideo(setup: TransportVideoSetup): Promise<void>
    setupHostAudio(setup: TransportAudioSetup): Promise<void>

    onclose: ((shutdown: TransportShutdown) => void) | null
    close(): Promise<void>

    getStats(): Promise<Record<string, string>>
}

export type TransportChannel = VideoTrackTransportChannel | AudioTrackTransportChannel | DataTransportChannel
interface TransportChannelBase {
    readonly type: string

    readonly canReceive: boolean
    readonly canSend: boolean
}

export interface TrackTransportChannel extends TransportChannelBase {
    setTrack(track: MediaStreamTrack | null): void

    addTrackListener(listener: (track: MediaStreamTrack) => void): void
    removeTrackListener(listener: (track: MediaStreamTrack) => void): void
}
export interface VideoTrackTransportChannel extends TrackTransportChannel {
    readonly type: "videotrack"
}
export interface AudioTrackTransportChannel extends TrackTransportChannel {
    readonly type: "audiotrack"
}

export interface DataTransportChannel extends TransportChannelBase {
    readonly type: "data"

    addReceiveListener(listener: (data: ArrayBuffer) => void): void
    removeReceiveListener(listener: (data: ArrayBuffer) => void): void

    send(message: ArrayBuffer): void
    estimatedBufferedBytes(): number | null
}