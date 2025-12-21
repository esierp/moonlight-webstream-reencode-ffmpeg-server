import { TransportChannelId } from "../../api_bindings.js";
import { ByteBuffer } from "../buffer.js";
import { Logger } from "../log.js";
import { DataTransportChannel, Transport, TransportAudioSetup, TransportChannel, TransportChannelIdKey, TransportChannelIdValue, TransportShutdown, TransportVideoSetup } from "./index.js";

export class WebSocketTransport implements Transport {
    readonly implementationName: string = "web_socket"

    private logger: Logger | null = null
    private ws: WebSocket
    private buffer: ByteBuffer

    private channels: Array<TransportChannel> = []

    constructor(ws: WebSocket, buffer: ByteBuffer, logger: Logger | null) {
        if (logger) {
            this.logger = logger
        }

        this.ws = ws
        this.buffer = buffer

        // Very important, set the binary type to arraybuffer
        this.ws.binaryType = "arraybuffer"

        for (const keyRaw in TransportChannelId) {
            const key = keyRaw as TransportChannelIdKey
            const id = TransportChannelId[key]

            this.channels[id] = new WebSocketDataTransportChannel(this.ws, id, this.buffer)
        }
    }

    getChannel(id: TransportChannelIdValue): TransportChannel {
        return this.channels[id]
    }

    async setupHostVideo(setup: TransportVideoSetup): Promise<void> {
        if (setup.type.indexOf("data") == -1) {
            this.logger?.debug("Cannot use Web Socket Transport: Found no supported video pipeline")
            throw "Cannot use Web Socket Transport: Found no supported video pipeline"
        }
    }
    async setupHostAudio(setup: TransportAudioSetup): Promise<void> {
        if (setup.type.indexOf("data") == -1) {
            this.logger?.debug("Cannot use Web Socket Transport: Found no supported audio pipeline")
            throw "Cannot use Web Socket Transport: Found no supported audio pipeline"
        }
    }

    onclose: ((shutdown: TransportShutdown) => void) | null = null

    async close(): Promise<void> {
        // do nothing, we don't own this ws, the stream owns the ws
        // -> maybe we changed protocol
    }
    async getStats(): Promise<Record<string, string>> {
        // TODO: maybe a ping (from browser ws to streamer) to get rtt
        return {}
    }

}

class WebSocketDataTransportChannel implements DataTransportChannel {
    readonly type: "data" = "data"

    private ws: WebSocket
    private id: TransportChannelIdValue
    private buffer: ByteBuffer

    constructor(ws: WebSocket, id: TransportChannelIdValue, buffer: ByteBuffer) {
        this.ws = ws
        this.id = id
        this.buffer = buffer

        this.ws.addEventListener("message", this.onMessage.bind(this))
    }

    canReceive: boolean = true
    canSend: boolean = true

    private receiveListeners: Array<(data: ArrayBuffer) => void> = []
    addReceiveListener(listener: (data: ArrayBuffer) => void): void {
        this.receiveListeners.push(listener)
    }
    removeReceiveListener(listener: (data: ArrayBuffer) => void): void {
        const index = this.receiveListeners.indexOf(listener)
        if (index != -1) {
            this.receiveListeners.splice(index, 1)
        }
    }

    private onMessage(event: MessageEvent) {
        const data = event.data
        if (!(data instanceof ArrayBuffer)) {
            return
        }

        this.buffer.reset()

        this.buffer.putU8Array(new Uint8Array(data))

        this.buffer.flip()

        const id = this.buffer.getU8()
        if (id != this.id) {
            return
        }

        const buffer = this.buffer.getRemainingBuffer()
        for (const listener of this.receiveListeners) {
            listener(buffer.buffer)
        }
    }

    send(message: ArrayBuffer): void {
        this.buffer.reset()

        this.buffer.putU8(this.id)
        this.buffer.putU8Array(new Uint8Array(message))

        this.buffer.flip()

        this.ws.send(this.buffer.getRemainingBuffer())
    }

    estimatedBufferedBytes(): number | null {
        return null
    }

    close() {
        this.ws.removeEventListener("message", this.onMessage.bind(this))
    }
}