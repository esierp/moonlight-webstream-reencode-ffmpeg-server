import { AudioPlayer, DataAudioPlayer, TrackAudioPlayer } from "./index.js"
import { AudioDecoderPipe } from "./audio_decoder_pipe.js"
import { AudioElementPlayer } from "./audio_element.js"
import { AudioMediaStreamTrackGeneratorPipe } from "./media_stream_track_generator_pipe.js"
import { Logger } from "../log.js"

type PipelineResult<T> = { audioPlayer: T, error: false } | { audioPlayer: null, error: true }

interface FinalAudioRenderer {
    new(logger?: Logger): AudioPlayer

    readonly type: string
    isBrowserSupported(): boolean
}
const FINAL_AUDIO_RENDERER: Array<FinalAudioRenderer> = [
    AudioElementPlayer
]

interface AudioPipe {
    new(base: any, logger?: Logger): AudioPlayer

    readonly type: string
    isBrowserSupported(): boolean
}
const PIPE_TYPES: Array<string> = ["data", "audiotrack", "audiosample"]
const AUDIO_PIPES: Record<string, AudioPipe> = {
    data_to_audiosample: AudioDecoderPipe,
    audiotrack_to_audiosample: AudioMediaStreamTrackGeneratorPipe,
}

export type AudioPipelineOptions = {
}

export function buildAudioPipeline(type: "audiotrack", settings: AudioPipelineOptions, logger?: Logger): PipelineResult<TrackAudioPlayer>
export function buildAudioPipeline(type: "data", settings: AudioPipelineOptions, logger?: Logger): PipelineResult<DataAudioPlayer>

// TODO: use logger
export function buildAudioPipeline(type: string, settings: AudioPipelineOptions, logger?: Logger): PipelineResult<AudioPlayer> {
    logger?.debug(`Building audio pipeline with output "${type}"`)

    // TODO dynamically create pipelines based on browser support

    if (type == "audiotrack") {
        if (AudioElementPlayer.isBrowserSupported()) {
            const audioPlayer = new AudioElementPlayer()

            return { audioPlayer, error: false }
        } else {
            logger?.debug("AudioElementPlayer is not supported -> cannot play audio", { type: "fatal" })
            return { audioPlayer: null, error: true }
        }
    } else if (type == "data") {
        if (AudioDecoderPipe.isBrowserSupported() && AudioMediaStreamTrackGeneratorPipe.isBrowserSupported() && AudioElementPlayer.isBrowserSupported()) {
            const audioPlayer = new AudioDecoderPipe(new AudioMediaStreamTrackGeneratorPipe(new AudioElementPlayer()))

            return { audioPlayer, error: false }
        } else {
            logger?.debug(`One of AudioDecoder,AudioMediaStreamTrackGenerator,AudioElementPlayer is not supported -> cannot play audio`, { type: "fatal" })
            return { audioPlayer: null, error: true }
        }
    }

    logger?.debug("No supported audio player found!")
    return { audioPlayer: null, error: true }
}