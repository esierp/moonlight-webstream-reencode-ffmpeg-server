import { ByteBuffer } from "../buffer.js";
import { DataVideoRenderer, VideoRenderer, VideoRendererSetup } from "./index.js";

export class DepacketizeVideoPipe<T extends DataVideoRenderer> extends VideoRenderer {

    private base: T

    private frameDurationMicroseconds = 0
    private buffer = new ByteBuffer(5)

    constructor(base: T) {
        super(`depacketize_video -> ${base.implementationName}`)
        this.base = base
    }

    submitPacket(buffer: ArrayBuffer) {
        const array = new Uint8Array(buffer)

        this.buffer.reset()

        this.buffer.putU8Array(array.slice(0, 5))

        this.buffer.flip()

        const frameType = this.buffer.getU8()
        const timestamp = this.buffer.getU32()

        this.base.submitDecodeUnit({
            type: frameType == 0 ? "delta" : "key",
            data: array.slice(5).buffer,
            durationMicroseconds: this.frameDurationMicroseconds,
            timestampMicroseconds: timestamp,
        })
    }

    setup(setup: VideoRendererSetup): void {
        this.base.setup(setup)
        this.frameDurationMicroseconds = 1000000 / setup.fps
    }
    cleanup(): void {
        this.base.cleanup()
    }

    onUserInteraction(): void {
        this.base.onUserInteraction()
    }

    getStreamRect(): DOMRect {
        return this.base.getStreamRect()
    }

    mount(parent: HTMLElement): void {
        this.base.mount(parent)
    }
    unmount(parent: HTMLElement): void {
        this.base.unmount(parent)
    }

}