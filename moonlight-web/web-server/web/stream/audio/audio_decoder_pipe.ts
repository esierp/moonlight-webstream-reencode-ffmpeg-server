import { Logger } from "../log.js";
import { AudioDecodeUnit, AudioPlayerSetup, DataAudioPlayer, SampleAudioPlayer } from "./index.js";

export class AudioDecoderPipe<T extends SampleAudioPlayer> extends DataAudioPlayer {

    static isBrowserSupported(): boolean {
        return "AudioDecoder" in window
    }

    private logger: Logger | null = null

    private base: T

    private errored = false
    private decoder: AudioDecoder

    constructor(base: T, logger?: Logger) {
        super(`audio_decoder -> ${base.implementationName}`)
        this.logger = logger ?? null

        this.base = base

        this.decoder = new AudioDecoder({
            error: this.onError.bind(this),
            output: this.onOutput.bind(this)
        })
    }

    private onError(error: any) {
        this.errored = true

        this.logger?.debug(`AudioDecoder has an error ${"toString" in error ? error.toString() : `${error}`}`, { type: "fatal" })
        console.error(error)
    }

    private onOutput(sample: AudioData) {
        this.base.submitSample(sample)
    }

    setup(setup: AudioPlayerSetup): void {
        this.base.setup(setup)

        this.decoder.configure({
            codec: "opus",
            numberOfChannels: setup.channels,
            sampleRate: setup.sampleRate
        })
    }

    private isFirstPacket = true

    decodeAndPlay(unit: AudioDecodeUnit): void {
        if (this.errored) {
            console.debug("Cannot submit audio decode unit because the stream errored")
            return
        }

        const chunk = new EncodedAudioChunk({
            type: this.isFirstPacket ? "key" : "delta",
            data: unit.data,
            timestamp: unit.timestampMicroseconds,
            duration: unit.durationMicroseconds,
            // We should be allowed to transfer because this data won't be used in the future
            transfer: [unit.data]
        })
        this.isFirstPacket = false

        this.decoder.decode(chunk)
    }

    cleanup(): void {
        this.base.cleanup()

        this.decoder.close()
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