import { CanvasVideoRenderer } from "./canvas_element.js"
import { VideoElementRenderer } from "./video_element.js"
import { VideoMediaStreamTrackProcessorPipe } from "./media_stream_track_processor_pipe.js"
import { TrackVideoRenderer, VideoRenderer } from "./index.js"
import { VideoDecoderPipe } from "./video_decoder_pipe.js"
import { DepacketizeVideoPipe } from "./depackitize_video_pipe.js"
import { Logger } from "../log.js"
import { VideoTrackGeneratorPipe } from "./video_track_generator.js"
import { VideoMediaStreamTrackGeneratorPipe } from "./media_stream_track_generator_pipe.js"
import { andVideoCodecs, hasAnyCodec, VideoCodecSupport } from "../video.js"
import { buildPipeline, gatherPipeInfo, getPipe, OutputPipeStatic, PipeInfoStatic, PipeStatic } from "../pipeline/index.js"
import { DataPipe } from "../pipeline/pipes.js"
import { workerPipe } from "../pipeline/worker_pipe.js"
import { WorkerDataSendPipe, WorkerVideoFrameReceivePipe } from "../pipeline/worker_io.js"

// -- Custom worker pipelines
const TestWorkerPipeline1 = workerPipe("TestWorkerPipeline1", { pipes: ["WorkerDataReceivePipe", "DepacketizeVideoPipe", "VideoDecoderPipe", "WorkerVideoFrameSendPipe"] })

// -- Gather information about the browser
interface VideoRendererStatic extends PipeInfoStatic, OutputPipeStatic { }

// TODO: print info
const VIDEO_RENDERERS: Array<VideoRendererStatic> = [
    VideoElementRenderer,
    CanvasVideoRenderer,
]

// -- Build the pipeline
export type VideoPipelineOptions = {
    supportedVideoCodecs: VideoCodecSupport
    canvasRenderer: boolean
}

type PipelineResult<T> = { videoRenderer: T, supportedCodecs: VideoCodecSupport, error: false } | { videoRenderer: null, supportedCodecs: null, error: true }

type Pipeline = { input: string, pipes: Array<PipeStatic>, renderer: VideoRendererStatic }

const FORCE_CANVAS_PIPELINES: Array<Pipeline> = [
    { input: "videotrack", pipes: [VideoMediaStreamTrackProcessorPipe], renderer: CanvasVideoRenderer },
    { input: "data", pipes: [DepacketizeVideoPipe, VideoDecoderPipe], renderer: CanvasVideoRenderer },
]

const PIPELINES: Array<Pipeline> = [
    { input: "videotrack", pipes: [], renderer: VideoElementRenderer },
    { input: "videotrack", pipes: [], renderer: VideoElementRenderer },
    { input: "videotrack", pipes: [VideoMediaStreamTrackProcessorPipe], renderer: CanvasVideoRenderer },
    { input: "data", pipes: [DepacketizeVideoPipe, VideoDecoderPipe, VideoMediaStreamTrackGeneratorPipe], renderer: VideoElementRenderer },
    { input: "data", pipes: [DepacketizeVideoPipe, VideoDecoderPipe, VideoTrackGeneratorPipe], renderer: VideoElementRenderer },
    { input: "data", pipes: [DepacketizeVideoPipe, VideoDecoderPipe], renderer: CanvasVideoRenderer },
]
const TEST_PIPELINES: Array<Pipeline> = [
    { input: "data", pipes: [WorkerDataSendPipe, TestWorkerPipeline1, WorkerVideoFrameReceivePipe], renderer: CanvasVideoRenderer }
]

export async function buildVideoPipeline(type: "videotrack", settings: VideoPipelineOptions, logger?: Logger): Promise<PipelineResult<TrackVideoRenderer & VideoRenderer>>
export async function buildVideoPipeline(type: "data", settings: VideoPipelineOptions, logger?: Logger): Promise<PipelineResult<DataPipe & VideoRenderer>>

export async function buildVideoPipeline(type: string, settings: VideoPipelineOptions, logger?: Logger): Promise<PipelineResult<VideoRenderer>> {
    const pipesInfo = await gatherPipeInfo()

    logger?.debug(`Building video pipeline with output "${type}"`)

    let pipelines: Array<Pipeline> = []
    // Forced renderer
    if (settings.canvasRenderer) {
        logger?.debug("Forcing canvas renderer")

        pipelines = FORCE_CANVAS_PIPELINES
    } else {
        logger?.debug("Selecting pipeline automatically")

        pipelines = PIPELINES
    }

    // TODO: REMOVE TEST PIPELINES!
    // pipelines = TEST_PIPELINES

    pipelineLoop: for (const pipeline of pipelines) {
        if (pipeline.input != type) {
            continue
        }

        // Check if supported and contains codecs
        let supportedCodecs = settings.supportedVideoCodecs
        for (const pipe of pipeline.pipes) {
            const pipeInfo = pipesInfo.get(pipe)
            if (!pipeInfo) {
                logger?.debug(`Failed to query info for video pipe ${pipe.name}`)
                continue pipelineLoop
            }

            if (!pipeInfo.executionEnvironment.main) {
                continue pipelineLoop
            }

            if (pipeInfo.supportedVideoCodecs) {
                supportedCodecs = andVideoCodecs(supportedCodecs, pipeInfo.supportedVideoCodecs)
            }
        }

        const rendererInfo = await pipeline.renderer.getInfo()
        if (!rendererInfo) {
            logger?.debug(`Failed to query info for video renderer ${pipeline.renderer.name}`)
            continue pipelineLoop
        }

        if (!rendererInfo.executionEnvironment.main) {
            continue pipelineLoop
        }
        if (rendererInfo.supportedVideoCodecs) {
            supportedCodecs = andVideoCodecs(supportedCodecs, rendererInfo.supportedVideoCodecs)
        }

        if (!hasAnyCodec(supportedCodecs)) {
            logger?.debug(`Not using pipe ${pipeline.pipes.map(pipe => pipe.name).join(" -> ")} -> ${pipeline.renderer.name} (renderer) because it doesn't support any codec the user wants`)
            continue pipelineLoop
        }

        // Build that pipeline
        const videoRenderer = buildPipeline(pipeline.renderer, { pipes: pipeline.pipes }, logger)
        if (!videoRenderer) {
            logger?.debug("Failed to build video pipeline")
            return { videoRenderer: null, supportedCodecs: null, error: true }
        }

        return { videoRenderer: videoRenderer as VideoRenderer, supportedCodecs, error: false }
    }

    logger?.debug("No supported video renderer found!")
    return { videoRenderer: null, supportedCodecs: null, error: true }
}