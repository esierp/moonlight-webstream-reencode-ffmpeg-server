import { checkExecutionEnvironment } from "../pipeline/worker_pipe.js";
import { allVideoCodecs } from "../video.js";
import { FrameVideoRenderer, TrackVideoRenderer, VideoRendererInfo, VideoRendererSetup } from "./index.js";

export class VideoMediaStreamTrackGeneratorPipe<T extends TrackVideoRenderer> extends FrameVideoRenderer {

    static readonly baseType: "videotrack" = "videotrack"

    static async getInfo(): Promise<VideoRendererInfo> {
        // https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackGenerator
        return {
            executionEnvironment: await checkExecutionEnvironment("MediaStreamTrackGenerator"),
            supportedCodecs: allVideoCodecs()
        }
    }

    private base: T

    private trackGenerator: MediaStreamTrackGenerator
    private writer: WritableStreamDefaultWriter<VideoFrame>

    constructor(base: T) {
        super(`video_media_stream_track_generator -> ${base.implementationName}`)
        this.base = base

        this.trackGenerator = new MediaStreamTrackGenerator({ kind: "video" })
        this.writer = this.trackGenerator.writable.getWriter()
    }

    private isFirstSample = true
    submitFrame(frame: VideoFrame): void {
        if (this.isFirstSample) {
            this.isFirstSample = false

            this.base.setTrack(this.trackGenerator)
        }
        this.writer.write(frame)
    }

    async setup(setup: VideoRendererSetup): Promise<void> {
        await this.base.setup(setup)
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