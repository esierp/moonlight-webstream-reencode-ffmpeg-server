import { AudioPlayerSetup, SampleAudioPlayer, TrackAudioPlayer } from "./index.js";

export class AudioMediaStreamTrackGeneratorPipe<T extends TrackAudioPlayer> extends SampleAudioPlayer {

    static isBrowserSupported(): boolean {
        return "MediaStreamTrackGenerator" in window
    }

    private base: T

    private trackGenerator: MediaStreamTrackGenerator
    private writer: WritableStreamDefaultWriter

    constructor(base: T) {
        super(`audio_media_stream_track_generator -> ${base.implementationName}`)
        this.base = base

        this.trackGenerator = new MediaStreamTrackGenerator({ kind: "audio" })
        this.writer = this.trackGenerator.writable.getWriter()
    }

    private isFirstSample = true
    submitSample(sample: AudioData): void {
        if (this.isFirstSample) {
            this.isFirstSample = false

            this.base.setTrack(this.trackGenerator)
        }
        this.writer.write(sample)
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