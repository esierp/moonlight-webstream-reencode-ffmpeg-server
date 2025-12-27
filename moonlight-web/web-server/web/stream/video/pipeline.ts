import { CanvasVideoRenderer } from "./canvas_element.js"
import { VideoElementRenderer } from "./video_element.js"
import { VideoMediaStreamTrackProcessorPipe } from "./media_stream_track_processor_pipe.js"
import { PacketVideoRenderer, TrackVideoRenderer, VideoRenderer, VideoRendererInfo } from "./index.js"
import { VideoDecoderPipe } from "./video_decoder_pipe.js"
import { DepacketizeVideoPipe } from "./depackitize_video_pipe.js"
import { Logger } from "../log.js"
import { VideoTrackGeneratorPipe } from "./video_track_generator.js"
import { VideoMediaStreamTrackGeneratorPipe } from "./media_stream_track_generator_pipe.js"
import { andVideoCodecs, hasAnyCodec, VideoCodecSupport } from "../video.js"


// -- Gather information about the browser
interface VideoRendererStatic {
    readonly type: string

    getInfo(): Promise<VideoRendererInfo>
    new(logger?: Logger): VideoRenderer
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
    supportedVideoCodecs: VideoCodecSupport
    canvasRenderer: boolean
}

type PipelineResult<T> = { videoRenderer: T, supportedCodecs: VideoCodecSupport, error: false } | { videoRenderer: null, supportedCodecs: null, error: true }

type Pipeline = { input: string, pipes: Array<VideoPipeStatic>, renderer: VideoRendererStatic }

const FORCE_CANVAS_PIPELINES: Array<Pipeline> = [
    { input: "videotrack", pipes: [], renderer: VideoElementRenderer },
    { input: "videotrack", pipes: [VideoMediaStreamTrackProcessorPipe], renderer: CanvasVideoRenderer },
    { input: "data", pipes: [DepacketizeVideoPipe, VideoDecoderPipe], renderer: CanvasVideoRenderer },
]

const PIPELINES: Array<Pipeline> = [
    { input: "videotrack", pipes: [], renderer: VideoElementRenderer },
    { input: "videotrack", pipes: [VideoMediaStreamTrackProcessorPipe], renderer: CanvasVideoRenderer },
    { input: "data", pipes: [DepacketizeVideoPipe, VideoDecoderPipe, VideoMediaStreamTrackGeneratorPipe], renderer: VideoElementRenderer },
    { input: "data", pipes: [DepacketizeVideoPipe, VideoDecoderPipe, VideoTrackGeneratorPipe], renderer: VideoElementRenderer },
    { input: "data", pipes: [DepacketizeVideoPipe, VideoDecoderPipe], renderer: CanvasVideoRenderer },
]

export async function buildVideoPipeline(type: "videotrack", settings: VideoPipelineOptions, logger?: Logger): Promise<PipelineResult<TrackVideoRenderer>>
export async function buildVideoPipeline(type: "data", settings: VideoPipelineOptions, logger?: Logger): Promise<PipelineResult<PacketVideoRenderer>>

export async function buildVideoPipeline(type: string, settings: VideoPipelineOptions, logger?: Logger): Promise<PipelineResult<VideoRenderer>> {
    const videoInfo = await VIDEO_INFO
    logger?.debug(`Supported Video Renderers / Pipes: {`)
    let isFirst = true
    for (const [key, value] of videoInfo.entries()) {
        logger?.debug(`${isFirst ? " " : ","}  "${key.name}": ${JSON.stringify(value)}`)
        isFirst = false
    }
    logger?.debug(`}`)

    logger?.debug(`Building video pipeline with output "${type}"`)

    let pipelines = []
    // Forced renderer
    if (settings.canvasRenderer) {
        logger?.debug("Forcing canvas renderer")

        pipelines = FORCE_CANVAS_PIPELINES
    } else {
        logger?.debug("Selecting pipeline automatically")

        pipelines = PIPELINES
    }

    pipelineLoop: for (const pipeline of pipelines) {
        if (pipeline.input != type) {
            continue
        }

        // Check if supported and contains codecs
        let supportedCodecs = settings.supportedVideoCodecs
        for (const pipe of pipeline.pipes) {
            const pipeInfo = videoInfo.get(pipe)
            if (!pipeInfo) {
                logger?.debug(`Failed to query info for video pipe ${pipe.name}`)
                continue pipelineLoop
            }

            if (!pipeInfo.executionEnvironment.main) {
                continue pipelineLoop
            }

            supportedCodecs = andVideoCodecs(supportedCodecs, pipeInfo.supportedCodecs)
        }

        const rendererInfo = videoInfo.get(pipeline.renderer)
        if (!rendererInfo) {
            logger?.debug(`Failed to query info for video renderer ${pipeline.renderer.name}`)
            continue pipelineLoop
        }

        if (!rendererInfo.executionEnvironment.main) {
            continue pipelineLoop
        }
        supportedCodecs = andVideoCodecs(supportedCodecs, rendererInfo.supportedCodecs)

        if (!hasAnyCodec(supportedCodecs)) {
            logger?.debug(`Not using pipe ${pipeline.pipes.map(pipe => pipe.name).join(" -> ")} -> ${pipeline.renderer.name} (renderer) because it doesn't support any codec`)
            continue pipelineLoop
        }

        // Build that pipeline
        let previousPipe = new pipeline.renderer(logger)
        for (let index = pipeline.pipes.length - 1; index >= 0; index--) {
            const pipe = pipeline.pipes[index];

            previousPipe = new pipe(previousPipe, logger)
        }

        return { videoRenderer: previousPipe, supportedCodecs, error: false }
    }

    logger?.debug("No supported video renderer found!")
    return { videoRenderer: null, supportedCodecs: null, error: true }
}