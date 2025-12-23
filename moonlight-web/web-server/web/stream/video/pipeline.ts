import { CanvasVideoRenderer } from "./canvas_element.js"
import { VideoElementRenderer } from "./video_element.js"
import { VideoMediaStreamTrackProcessorPipe } from "./media_stream_track_processor_pipe.js"
import { PacketVideoRenderer, TrackVideoRenderer, VideoRenderer, VideoRendererInfo } from "./index.js"
import { VideoDecoderPipe } from "./video_decoder_pipe.js"
import { DepacketizeVideoPipe } from "./depackitize_video_pipe.js"
import { Logger } from "../log.js"
import { VideoTrackGeneratorPipe } from "./video_track_generator.js"
import { VideoMediaStreamTrackGeneratorPipe } from "./media_stream_track_generator_pipe.js"


// -- Gather information about the browser
interface VideoRendererStatic {
    readonly type: string

    getInfo(): Promise<VideoRendererInfo>
    new(): VideoRenderer
}
interface VideoPipeStatic {
    readonly baseType: string

    readonly type: string

    getInfo(): Promise<VideoRendererInfo>
    new(base: any, logger?: Logger): VideoRenderer
}

const VIDEO_RENDERERS: Array<VideoRendererStatic> = [
    VideoElementRenderer,
    CanvasVideoRenderer,
]
const VIDEO_PIPES: Array<VideoPipeStatic> = [
    DepacketizeVideoPipe,
    VideoMediaStreamTrackGeneratorPipe,
    VideoMediaStreamTrackProcessorPipe,
    VideoDecoderPipe,
    VideoTrackGeneratorPipe,
]

async function gatherInfo(): Promise<Map<VideoRendererStatic | VideoPipeStatic, VideoRendererInfo>> {
    const map = new Map()

    const promises = []

    const all: Array<VideoRendererStatic | VideoPipeStatic> = [...VIDEO_RENDERERS]
    all.push(...VIDEO_PIPES)
    for (const renderer of all) {
        promises.push(renderer.getInfo().then(info => {
            map.set(renderer, info)
        }))
    }

    await Promise.all(promises)

    return map
}
const VIDEO_INFO: Promise<Map<VideoRendererStatic | VideoPipeStatic, VideoRendererInfo>> = gatherInfo()

// -- Build the pipeline
export type VideoPipelineOptions = {
    canvasRenderer: boolean
}

type PipelineResult<T> = { videoRenderer: T, error: false } | { videoRenderer: null, error: true }

export async function buildVideoPipeline(type: "videotrack", settings: VideoPipelineOptions, logger?: Logger): Promise<PipelineResult<TrackVideoRenderer>>
export async function buildVideoPipeline(type: "data", settings: VideoPipelineOptions, logger?: Logger): Promise<PipelineResult<PacketVideoRenderer>>

export async function buildVideoPipeline(type: string, settings: VideoPipelineOptions, logger?: Logger): Promise<PipelineResult<VideoRenderer>> {
    const videoInfo = await VIDEO_INFO
    logger?.debug(`Supported Video Renderers / Pipes: [`)
    for (const [key, value] of videoInfo.entries()) {
        logger?.debug(`  ${key.name}: ${JSON.stringify(value)}`)
    }
    logger?.debug(`]`)

    logger?.debug(`Building video pipeline with output "${type}"`)

    // Forced renderer
    if (settings.canvasRenderer) {
        logger?.debug("Forcing canvas renderer")

        if (type == "videotrack") {
            if (
                videoInfo.get(VideoMediaStreamTrackProcessorPipe)?.executionEnvironment.main
                && videoInfo.get(CanvasVideoRenderer)?.executionEnvironment.main
            ) {
                const videoRenderer = new VideoMediaStreamTrackProcessorPipe(new CanvasVideoRenderer())

                return { videoRenderer, error: false }
            }
        } else if (type == "data") {
            if (
                videoInfo.get(DepacketizeVideoPipe)?.executionEnvironment.main
                && videoInfo.get(VideoDecoderPipe)?.executionEnvironment.main
                && videoInfo.get(CanvasVideoRenderer)?.executionEnvironment.main
            ) {
                const videoRenderer = new DepacketizeVideoPipe(new VideoDecoderPipe(new CanvasVideoRenderer(), logger))

                return { videoRenderer, error: false }
            }
        }
        return { videoRenderer: null, error: true }
    }
    logger?.debug("Selecting pipeline automatically")

    // TODO more dynamically create pipelines based on browser support

    if (type == "data") {
        if (
            videoInfo.get(DepacketizeVideoPipe)?.executionEnvironment.main
            && videoInfo.get(VideoDecoderPipe)?.executionEnvironment.main
            && videoInfo.get(VideoMediaStreamTrackGeneratorPipe)?.executionEnvironment.main
            && videoInfo.get(VideoElementRenderer)?.executionEnvironment.main
        ) {
            const videoRenderer = new DepacketizeVideoPipe(new VideoDecoderPipe(new VideoMediaStreamTrackGeneratorPipe(new VideoElementRenderer()), logger))

            return { videoRenderer, error: false }
        } else if (
            videoInfo.get(DepacketizeVideoPipe)?.executionEnvironment.main
            && videoInfo.get(VideoDecoderPipe)?.executionEnvironment.main
            && videoInfo.get(VideoTrackGeneratorPipe)?.executionEnvironment.main
            && videoInfo.get(VideoElementRenderer)?.executionEnvironment.main
        ) {
            const videoRenderer = new DepacketizeVideoPipe(new VideoDecoderPipe(new VideoMediaStreamTrackGeneratorPipe(new VideoElementRenderer()), logger))

            return { videoRenderer, error: false }
        } else if (
            videoInfo.get(DepacketizeVideoPipe)?.executionEnvironment.main
            && videoInfo.get(VideoDecoderPipe)?.executionEnvironment.main
            && videoInfo.get(CanvasVideoRenderer)?.executionEnvironment.main
        ) {
            const videoRenderer = new DepacketizeVideoPipe(new VideoDecoderPipe(new CanvasVideoRenderer(), logger))

            return { videoRenderer, error: false }
        }
    } else if (type == "videotrack") {
        if (
            videoInfo.get(VideoElementRenderer)?.executionEnvironment.main
        ) {
            const videoRenderer = new VideoElementRenderer()

            return { videoRenderer, error: false }
        }
    }

    logger?.debug("No supported video renderer found!")
    return { videoRenderer: null, error: true }
}