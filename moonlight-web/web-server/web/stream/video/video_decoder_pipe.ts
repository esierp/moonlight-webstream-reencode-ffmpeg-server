import { ByteBuffer } from "../buffer.js";
import { Logger } from "../log.js";
import { checkExecutionEnvironment } from "../pipeline/worker_pipe.js";
import { VIDEO_DECODER_CODECS } from "../video.js";
import { DataVideoRenderer, FrameVideoRenderer, VideoDecodeUnit, VideoRendererInfo, VideoRendererSetup } from "./index.js";

const START_CODE_SHORT = new Uint8Array([0x00, 0x00, 0x01]); // 3-byte start code
const START_CODE_LONG = new Uint8Array([0x00, 0x00, 0x00, 0x01]); // 4-byte start code
function startsWith(buffer: Uint8Array, position: number, check: Uint8Array): boolean {
    for (let i = 0; i < check.length; i++) {
        if (buffer[position + i] != check[i]) {
            return false
        }
    }
    return true
}

export class VideoDecoderPipe<T extends FrameVideoRenderer> extends DataVideoRenderer {

    static readonly baseType: "videoframe" = "videoframe"

    static async getInfo(): Promise<VideoRendererInfo> {
        return {
            executionEnvironment: await checkExecutionEnvironment("VideoDecoder")
        }
    }

    private logger: Logger | null

    private base: T

    private errored = false
    private decoder: VideoDecoder

    constructor(base: T, logger?: Logger) {
        super(`video_decoder -> ${base.implementationName}`)
        this.logger = logger ?? null

        this.base = base

        this.decoder = new VideoDecoder({
            error: this.onError.bind(this),
            output: this.onOutput.bind(this)
        })
    }

    private onError(error: any) {
        this.errored = true

        this.logger?.debug(`VideoDecoder has an error ${"toString" in error ? error.toString() : `${error}`}`, { type: "fatal" })
        this.logger?.debug(`VideoDecoder config: ${JSON.stringify(this.translator?.getCurrentConfig())}`)
        console.error(error)
    }

    private onOutput(frame: VideoFrame) {
        this.base.submitFrame(frame)
    }

    private translator: CodecStreamTranslator | null = null

    setup(setup: VideoRendererSetup): void {
        const codec = VIDEO_DECODER_CODECS.find(codec => codec.key == setup.format)
        if (!codec) {
            this.logger?.debug("Failed to get codec configuration for WebCodecs VideoDecoder", { type: "fatal" })
            return
        }

        let translator

        if (setup.format == "H264" || setup.format == "H264_HIGH8_444") {
            translator = new H264StreamVideoTranslator(this.logger ?? undefined)
        } else if (setup.format == "H265" || setup.format == "H265_MAIN10" || setup.format == "H265_REXT8_444" || setup.format == "H265_REXT10_444") {
            translator = new H265StreamVideoTranslator(this.logger ?? undefined)
        } else if (setup.format == "AV1_MAIN8" || setup.format == "AV1_MAIN10" || setup.format == "AV1_HIGH8_444" || setup.format == "AV1_HIGH10_444") {
            // TODO: av1?
            this.errored = true
            this.logger?.debug("Av1 stream translator is not implemented currently!")
            return
        } else {
            this.errored = true
            this.logger?.debug(`Failed to find stream translator for codec ${setup.format}`)
            return
        }

        translator.setBaseConfig({
            codec: codec.codec,
            colorSpace: codec.colorSpace,
            optimizeForLatency: true
        })
        this.translator = translator

        this.base.setup(setup)
    }


    submitDecodeUnit(unit: VideoDecodeUnit): void {
        if (this.errored) {
            console.debug("Cannot submit video decode unit because the stream errored")
            return
        }

        if (!this.translator) {
            this.errored = true
            this.logger?.debug("Failed to process video chunk because no video stream translator was set!", { "type": "fatal" })
            return
        }

        const value = this.translator.submitDecodeUnit(unit)
        if (value.error) {
            this.errored = true
            this.logger?.debug("VideoDecoder has errored!")
            return
        }

        const { configure, chunk } = value

        if (!chunk) {
            console.debug("No chunk received!")
            return
        }

        if (configure) {
            this.decoder.reset()
            this.decoder.configure(configure)
        }

        this.decoder.decode(chunk)
    }

    cleanup(): void {
        this.decoder.close()

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

abstract class CodecStreamTranslator {

    protected logger: Logger | null

    constructor(logger?: Logger) {
        this.logger = logger ?? null
    }

    protected decoderConfig: VideoDecoderConfig | null = null

    setBaseConfig(decoderConfig: VideoDecoderConfig) {
        this.decoderConfig = decoderConfig
    }
    getCurrentConfig(): VideoDecoderConfig | null {
        return this.decoderConfig
    }

    protected currentFrame = new Uint8Array(1000)

    submitDecodeUnit(unit: VideoDecodeUnit): { configure: VideoDecoderConfig | null, chunk: EncodedVideoChunk | null, error: false } | { error: true } {
        if (!this.decoderConfig) {
            this.logger?.debug("Failed to retrieve decoderConfig which should already exist for VideoDecoder", { type: "fatal" })
            return { error: true }
        }

        // We're getting annex b prefixed nalus but we need length prefixed nalus -> convert them based on codec

        const { shouldProcess } = this.startProcessChunk(unit)

        if (!shouldProcess) {
            return { configure: null, chunk: null, error: false }
        }

        const data = new Uint8Array(unit.data)

        let unitBegin = 0
        let currentPosition = 0
        let currentFrameSize = 0

        let handleStartCode = () => {
            const slice = data.slice(unitBegin, currentPosition)

            const { include } = this.onChunkUnit(slice)

            if (include) {
                // Append size + data
                this.checkFrameBufferSize(currentFrameSize, slice.length + 4)

                // Append size
                const sizeBuffer = new ByteBuffer(4)
                sizeBuffer.putU32(slice.length)
                sizeBuffer.flip()

                this.currentFrame.set(sizeBuffer.getRemainingBuffer(), currentFrameSize)

                // Append data
                this.currentFrame.set(slice, currentFrameSize + 4)

                currentFrameSize += slice.length + 4
            }
        }

        while (currentPosition < data.length) {
            let startCodeLength = 0
            let foundStartCode = false

            if (startsWith(data, currentPosition, START_CODE_LONG)) {
                foundStartCode = true
                startCodeLength = START_CODE_LONG.length
            } else if (startsWith(data, currentPosition, START_CODE_SHORT)) {
                foundStartCode = true
                startCodeLength = START_CODE_SHORT.length
            }

            if (foundStartCode) {
                if (currentPosition != 0) {
                    handleStartCode()
                }

                currentPosition += startCodeLength
                unitBegin = currentPosition
            } else {
                currentPosition += 1;
            }
        }

        // The last nal also needs to get processed
        handleStartCode()

        const { reconfigure } = this.endChunk()

        const chunk = new EncodedVideoChunk({
            type: unit.type,
            timestamp: unit.timestampMicroseconds,
            duration: unit.durationMicroseconds,
            data: this.currentFrame.slice(0, currentFrameSize),
        })

        return {
            configure: reconfigure ? this.decoderConfig : null,
            chunk,
            error: false
        }
    }

    protected abstract startProcessChunk(unit: VideoDecodeUnit): { shouldProcess: boolean };
    protected abstract onChunkUnit(slice: Uint8Array): { include: boolean };
    protected abstract endChunk(): { reconfigure: boolean };

    protected checkFrameBufferSize(currentSize: number, requiredExtra: number) {
        if (currentSize + requiredExtra > this.currentFrame.length) {
            const newFrame = new Uint8Array((currentSize + requiredExtra) * 2);

            newFrame.set(this.currentFrame);
            this.currentFrame = newFrame;
        }
    }
}

// TODO: search for the spec of Avcc and adjust these to better comply / have more info

function h264NalType(header: number): number {
    return header & 0x1f;
}
function h264MakeAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
    const size =
        7 +                 // header
        2 + sps.length +    // SPS
        1 +                 // PPS count
        2 + pps.length;     // PPS

    const data = new Uint8Array(size);
    let i = 0;

    data[i++] = 0x01;      // configurationVersion
    data[i++] = sps[1];   // AVCProfileIndication
    data[i++] = sps[2];   // profile_compatibility
    data[i++] = sps[3];   // AVCLevelIndication
    data[i++] = 0xFF;     // lengthSizeMinusOne = 3 (4 bytes)

    data[i++] = 0xE1;     // numOfSPS = 1
    data[i++] = sps.length >> 8;
    data[i++] = sps.length & 0xff;
    data.set(sps, i);
    i += sps.length;

    data[i++] = 0x01;     // numOfPPS = 1
    data[i++] = pps.length >> 8;
    data[i++] = pps.length & 0xff;
    data.set(pps, i);

    return data;
}

class H264StreamVideoTranslator extends CodecStreamTranslator {
    constructor(logger?: Logger) {
        super(logger)
    }

    private hasDescription = false
    private pps: Uint8Array | null = null
    private sps: Uint8Array | null = null

    protected startProcessChunk(unit: VideoDecodeUnit): { shouldProcess: boolean } {
        return {
            shouldProcess: unit.type == "key" || this.hasDescription
        }
    }
    protected onChunkUnit(slice: Uint8Array): { include: boolean } {
        const nalType = h264NalType(slice[0])

        if (nalType == 7) {
            // Sps
            this.sps = new Uint8Array(slice)

            return { include: false }
        } else if (nalType == 8) {
            // Pps
            this.pps = new Uint8Array(slice)

            return { include: false }
        }

        return { include: true }
    }
    protected endChunk(): { reconfigure: boolean } {
        if (!this.decoderConfig) {
            throw "UNREACHABLE"
        }

        if (this.pps && this.sps) {
            const description = h264MakeAvcC(this.sps, this.pps)
            this.sps = null
            this.pps = null

            this.decoderConfig.description = description

            console.debug("Reset decoder config using Sps and Pps")

            this.hasDescription = true

            return { reconfigure: true }
        } else if (!this.hasDescription) {
            // TODO: maybe request another idr
            this.logger?.debug("Received key frame without Sps and Pps")
        }

        return { reconfigure: false }
    }
}

function h265NalType(header: number): number {
    return (header >> 1) & 0x3f;
}

function h265MakeHvcC(
    vps: Uint8Array,
    sps: Uint8Array,
    pps: Uint8Array
): Uint8Array {

    // Minimal hvcC with 3 arrays (VPS/SPS/PPS)
    const size =
        23 + // fixed header (minimal compliant)
        (3 * 3) + // array headers
        (2 + vps.length) +
        (2 + sps.length) +
        (2 + pps.length);

    const data = new Uint8Array(size);
    let i = 0;

    data[i++] = 1;        // configurationVersion

    // profile_tier_level
    data[i++] = (sps[1] >> 1) & 0x3f; // general_profile_space/tier/profile_idc
    data[i++] = 0;        // general_profile_compatibility_flags (part 1)
    data[i++] = 0;
    data[i++] = 0;
    data[i++] = 0;

    data[i++] = 0;        // general_constraint_indicator_flags (6 bytes)
    data[i++] = 0;
    data[i++] = 0;
    data[i++] = 0;
    data[i++] = 0;
    data[i++] = 0;

    data[i++] = sps[12];  // general_level_idc (heuristic, works in practice)

    data[i++] = 0xF0;     // min_spatial_segmentation_idc
    data[i++] = 0x00;

    data[i++] = 0xFC;     // parallelismType
    data[i++] = 0xFD;     // chromaFormat
    data[i++] = 0xF8;     // bitDepthLumaMinus8
    data[i++] = 0xF8;     // bitDepthChromaMinus8

    data[i++] = 0x00;     // avgFrameRate (2 bytes)
    data[i++] = 0x00;

    data[i++] = 0x0F;     // constantFrameRate + numTemporalLayers + lengthSizeMinusOne
    data[i++] = 3;        // numOfArrays

    // VPS
    data[i++] = 0x20;     // array_completeness=0, nal_unit_type=32
    data[i++] = 0;
    data[i++] = 1;
    data[i++] = vps.length >> 8;
    data[i++] = vps.length & 0xff;
    data.set(vps, i); i += vps.length;

    // SPS
    data[i++] = 0x21;     // nal_unit_type=33
    data[i++] = 0;
    data[i++] = 1;
    data[i++] = sps.length >> 8;
    data[i++] = sps.length & 0xff;
    data.set(sps, i); i += sps.length;

    // PPS
    data[i++] = 0x22;     // nal_unit_type=34
    data[i++] = 0;
    data[i++] = 1;
    data[i++] = pps.length >> 8;
    data[i++] = pps.length & 0xff;
    data.set(pps, i);

    return data;
}

class H265StreamVideoTranslator extends CodecStreamTranslator {
    constructor(logger?: Logger) {
        super(logger)
    }

    private hasDescription = false
    private vps: Uint8Array | null = null
    private sps: Uint8Array | null = null
    private pps: Uint8Array | null = null

    protected startProcessChunk(unit: VideoDecodeUnit): { shouldProcess: boolean } {
        return {
            shouldProcess: unit.type === "key" || this.hasDescription
        }
    }

    protected onChunkUnit(slice: Uint8Array): { include: boolean } {
        const nalType = h265NalType(slice[0])

        if (nalType === 32) {
            this.vps = new Uint8Array(slice)
            return { include: false }
        }
        if (nalType === 33) {
            this.sps = new Uint8Array(slice)
            return { include: false }
        }
        if (nalType === 34) {
            this.pps = new Uint8Array(slice)
            return { include: false }
        }

        return { include: true }
    }

    protected endChunk(): { reconfigure: boolean } {
        if (!this.decoderConfig) {
            throw "UNREACHABLE"
        }

        if (this.vps && this.sps && this.pps) {
            this.decoderConfig.description =
                h265MakeHvcC(this.vps, this.sps, this.pps)

            this.vps = this.sps = this.pps = null
            this.hasDescription = true

            console.debug("Reset decoder config using VPS/SPS/PPS")
            return { reconfigure: true }
        }

        if (!this.hasDescription) {
            this.logger?.debug("Received key frame without VPS/SPS/PPS")
        }

        return { reconfigure: false }
    }
}