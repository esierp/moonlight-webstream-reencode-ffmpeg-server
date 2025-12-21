import { AudioPlayer, AudioPlayerSetup, DataAudioPlayer } from "./index.js";

export class DepacketizeAudioPipe<T extends DataAudioPlayer> extends AudioPlayer {

    private base: T

    constructor(base: T) {
        super(`depacketize_audio -> ${base.implementationName}`)
        this.base = base
    }

    submitPacket(buffer: ArrayBuffer) {
        this.base.decodeAndPlay({
            data: buffer,
            // TODO: use actual timestamps / durations
            timestampMicroseconds: 0,
            durationMicroseconds: 0,
        })
    }

    setup(setup: AudioPlayerSetup): void {
        this.base.setup(setup)
    }
    cleanup(): void {
        this.base.cleanup()
    }

    onUserInteraction(): void {
        this.base.onUserInteraction()
    }

    mount(parent: HTMLElement): void {
        this.base.mount(parent)
    }
    unmount(parent: HTMLElement): void {
        this.base.unmount(parent)
    }

}