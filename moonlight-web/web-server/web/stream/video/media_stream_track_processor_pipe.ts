import { checkExecutionEnvironment } from "../pipeline/worker_pipe.js";
import { allVideoCodecs } from "../video.js";
import { FrameVideoRenderer, TrackVideoRenderer, VideoRendererInfo, VideoRendererSetup } from "./index.js";

function wait(time: number): Promise<void> {
    return new Promise((resolve, _reject) => {
        setTimeout(resolve, time)
    })
}

export class VideoMediaStreamTrackProcessorPipe<T extends FrameVideoRenderer> extends TrackVideoRenderer {

    static readonly baseType: "videoframe" = "videoframe"

    static async getInfo(): Promise<VideoRendererInfo> {
        // https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor
        return {
            executionEnvironment: await checkExecutionEnvironment("MediaStreamTrackProcessor"),
            supportedCodecs: allVideoCodecs()
        }
    }

    private running: boolean = false
    private newProcessor: boolean = false
    private trackProcessor: MediaStreamTrackProcessor | null = null

    private base: T

    constructor(base: T) {
        super(`media_stream_track_processor -> ${base.implementationName}`)
        this.base = base
    }

    setTrack(track: MediaStreamTrack): void {
        this.trackProcessor = new MediaStreamTrackProcessor({ track })
        this.newProcessor = true
    }

    private async readTrack() {
        let reader: ReadableStreamDefaultReader<VideoFrame> | null = null

        while (this.running) {
            if (!reader || this.newProcessor) {
                this.newProcessor = false

                if (this.trackProcessor?.readable.locked) {
                    // Shouldn't happen
                    throw "Canvas video track processor is locked"
                }

                const newReader = this.trackProcessor?.readable.getReader()
                if (newReader) {
                    reader = newReader
                }
                await wait(100)
                continue
            }

            // TODO: byob?
            const { done, value } = await reader.read()
            if (done) {
                console.error("Track Processor is done!")
                return
            }

            this.base.submitFrame(value)
        }
    }

    async setup(setup: VideoRendererSetup): Promise<void> {
        this.running = true
        this.readTrack()

        await this.base.setup(setup)
    }
    cleanup(): void {
        this.running = false
        try {
            if (this.trackProcessor) {
                this.trackProcessor.readable.cancel()
            }
        } catch (e) {
            console.error(e)
        }
        this.trackProcessor = null

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

    getStreamRect(): DOMRect {
        return this.base.getStreamRect()
    }

    getBase(): T {
        return this.base
    }
}