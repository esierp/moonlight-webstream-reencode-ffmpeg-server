import { checkExecutionEnvironment } from "../pipeline/worker_pipe.js";
import { allVideoCodecs } from "../video.js";
import { FrameVideoRenderer, TrackVideoRenderer, VideoRendererInfo, VideoRendererSetup } from "./index.js";

export class VideoTrackGeneratorPipe<T extends TrackVideoRenderer> extends FrameVideoRenderer {

    static readonly baseType: "videotrack" = "videotrack"

    static async getInfo(): Promise<VideoRendererInfo> {
        // https://developer.mozilla.org/en-US/docs/Web/API/VideoTrackGenerator
        return {
            executionEnvironment: await checkExecutionEnvironment("VideoTrackGenerator"),
            supportedCodecs: allVideoCodecs()
        }
    }

    private base: T

    private trackGenerator: VideoTrackGenerator
    private writer: WritableStreamDefaultWriter<VideoFrame>

    constructor(base: T) {
        super(`video_track_generator -> ${base.implementationName}`)
        this.base = base

        this.trackGenerator = new VideoTrackGenerator()
        this.writer = this.trackGenerator.writable.getWriter()
    }

    private isFirstSample = true
    submitFrame(frame: VideoFrame): void {
        if (this.isFirstSample) {
            this.isFirstSample = false

            this.base.setTrack(this.trackGenerator.track)
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