import { CanvasVideoRenderer } from "./canvas_element.js"
import { VideoElementRenderer } from "./video_element.js"
import { VideoMediaStreamTrackProcessorPipe } from "./media_stream_track_processor_pipe.js"
import { DataVideoRenderer, PacketVideoRenderer, TrackVideoRenderer, VideoRenderer } from "./index.js"
import { VideoDecoderPipe } from "./video_decoder_pipe.js"
import { DepacketizeVideoPipe } from "./depackitize_video_pipe.js"
import { Logger } from "../log.js"

type PipelineResult<T> = { videoRenderer: T, error: false } | { videoRenderer: null, error: true }

interface FinalVideoRenderer {
    new(logger?: Logger): VideoRenderer

    readonly type: string
    isBrowserSupported(): boolean
}
const FINAL_VIDEO_RENDERER: Array<FinalVideoRenderer> = [
    VideoElementRenderer,
    CanvasVideoRenderer
]

interface VideoPipe {
    new(base: any, logger?: Logger): VideoRenderer

    readonly type: string
    isBrowserSupported(): boolean
}
const PIPE_TYPES: Array<string> = ["data", "videotrack", "videoframe"]
const VIDEO_PIPES: Record<string, VideoPipe> = {
    videotrack_to_videoframe: VideoMediaStreamTrackProcessorPipe
}

export type VideoPipelineOptions = {
    canvasRenderer: boolean
}

export function buildVideoPipeline(type: "videotrack", settings: VideoPipelineOptions, logger?: Logger): PipelineResult<TrackVideoRenderer>
export function buildVideoPipeline(type: "data", settings: VideoPipelineOptions, logger?: Logger): PipelineResult<PacketVideoRenderer>

export function buildVideoPipeline(type: string, settings: VideoPipelineOptions, logger?: Logger): PipelineResult<VideoRenderer> {
    logger?.debug(`Building video pipeline with output "${type}"`)

    // Forced renderer
    if (settings.canvasRenderer) {
        logger?.debug("Forcing canvas renderer")

        if (type == "videotrack" && VideoMediaStreamTrackProcessorPipe.isBrowserSupported() && CanvasVideoRenderer.isBrowserSupported()) {
            const videoRenderer = new VideoMediaStreamTrackProcessorPipe(new CanvasVideoRenderer())

            return { videoRenderer, error: false }
        } else {
            logger?.debug("Failed to create video canvas renderer because it is not supported this this browser", { type: "fatal" })
            return { videoRenderer: null, error: true }
        }
    }

    if (type == "data") {
        if (VideoDecoderPipe.isBrowserSupported() && CanvasVideoRenderer.isBrowserSupported()) {
            const videoRenderer = new DepacketizeVideoPipe(new VideoDecoderPipe(new CanvasVideoRenderer()))

            return { videoRenderer, error: false }
        }
    }

    // TODO dynamically create pipelines based on browser support

    const directVideoRenderers = FINAL_VIDEO_RENDERER.filter(entry => entry.type == type && entry.isBrowserSupported())
    if (directVideoRenderers.length >= 1) {
        const videoRenderer = new directVideoRenderers[0](logger)
        return { videoRenderer, error: false }
    }

    logger?.debug("No supported video renderer found!", { type: "fatal" })
    return { videoRenderer: null, error: true }
}