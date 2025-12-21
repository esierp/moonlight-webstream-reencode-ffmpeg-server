import { StreamSupportedVideoFormats } from "../../api_bindings.js";
import { ByteBuffer } from "../buffer.js";
import { Logger } from "../log.js";
import { VIDEO_DECODER_CODECS } from "../video.js";
import { DataVideoRenderer, FrameVideoRenderer, VideoDecodeUnit, VideoRendererSetup } from "./index.js";

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

export class VideoDecoderPipe<T extends FrameVideoRenderer> extends DataVideoRenderer {

    static isBrowserSupported(): boolean {
        // TODO: check for config

        // We need the WebCodecs API
        return "VideoDecoder" in window
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
        console.error(error)
    }

    private onOutput(frame: VideoFrame) {
        this.base.submitFrame(frame)
    }

    private decoderConfig: VideoDecoderConfig | null = null
    setup(setup: VideoRendererSetup): void {
        const codec = VIDEO_DECODER_CODECS.find(codec => codec.key == setup.format)
        if (!codec) {
            this.logger?.debug("Failed to get codec configuration for WebCodecs VideoDecoder", { type: "fatal" })
            return
        }

        this.decoderConfig = {
            codec: codec.codec,
            colorSpace: codec.colorSpace,
            optimizeForLatency: true
        }

        this.base.setup(setup)
    }

    private hasDescription = false
    private pps: Uint8Array | null = null
    private sps: Uint8Array | null = null

    private currentFrame = new Uint8Array(1000)
    submitDecodeUnit(unit: VideoDecodeUnit): void {
        if (this.errored) {
            console.debug("Cannot submit video decode unit because the stream errored")
            return
        }

        // We're getting annex b prefixed nalus but we need length prefixed nalus -> convert them

        if (unit.type != "key" && !this.hasDescription) {
            return
        }

        const data = new Uint8Array(unit.data)

        let unitBegin = 0
        let currentPosition = 0
        let currentFrameSize = 0

        let handleStartCode = () => {
            const slice = data.slice(unitBegin, currentPosition)

            // Check if it's sps,pps
            const nalType = h264NalType(slice[0])
            if (nalType == 7) {
                // Sps
                this.sps = new Uint8Array(slice)
            } else if (nalType == 8) {
                // Pps
                this.pps = new Uint8Array(slice)
            } else {
                // Append if not sps / pps -> Append size + data
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

        if (this.pps && this.sps) {
            const description = h264MakeAvcC(this.sps, this.pps)
            this.sps = null
            this.pps = null

            if (!this.decoderConfig) {
                this.errored = true

                this.logger?.debug("Failed to retrieve decoderConfig which should already exist for VideoDecoder", { type: "fatal" })
                return
            }
            this.decoderConfig.description = description

            this.decoder.reset()
            this.decoder.configure(this.decoderConfig)

            console.debug("Reset decoder config using Sps and Pps")

            this.hasDescription = true
        } else if (!this.hasDescription) {
            // TODO: maybe request another idr
            this.logger?.debug("Received key frame without Sps and Pps")
            return
        }

        const chunk = new EncodedVideoChunk({
            type: unit.type,
            timestamp: unit.timestampMicroseconds,
            duration: unit.durationMicroseconds,
            data: this.currentFrame.slice(0, currentFrameSize),
        })

        this.decoder.decode(chunk)
    }
    private checkFrameBufferSize(currentSize: number, requiredExtra: number) {
        if (currentSize + requiredExtra > this.currentFrame.length) {
            const newFrame = new Uint8Array((currentSize + requiredExtra) * 2);

            newFrame.set(this.currentFrame);
            this.currentFrame = newFrame;
        }
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