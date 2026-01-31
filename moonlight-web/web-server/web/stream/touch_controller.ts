import { StreamControllerButton } from "../api_bindings.js"
import { emptyGamepadState, GamepadState, SUPPORTED_BUTTONS } from "./gamepad.js"
import { StreamInput } from "./input.js"

const VIRTUAL_CONTROLLER_ID = 0

const BUTTON_MAP: Record<string, number> = {
    a: StreamControllerButton.BUTTON_A,
    b: StreamControllerButton.BUTTON_B,
    x: StreamControllerButton.BUTTON_X,
    y: StreamControllerButton.BUTTON_Y,
    lb: StreamControllerButton.BUTTON_LB,
    rb: StreamControllerButton.BUTTON_RB,
    lt: StreamControllerButton.BUTTON_LB,
    rt: StreamControllerButton.BUTTON_RB,
    back: StreamControllerButton.BUTTON_BACK,
    play: StreamControllerButton.BUTTON_PLAY,
    ls: StreamControllerButton.BUTTON_LS_CLK,
    rs: StreamControllerButton.BUTTON_RS_CLK,
    up: StreamControllerButton.BUTTON_UP,
    down: StreamControllerButton.BUTTON_DOWN,
    left: StreamControllerButton.BUTTON_LEFT,
    right: StreamControllerButton.BUTTON_RIGHT,
}

type StickState = {
    active: boolean
    pointerId: number | null
    centerX: number
    centerY: number
    valueX: number
    valueY: number
}

export class TouchController {
    private root = document.createElement("div")
    private input: StreamInput
    private logDebug: ((message: string) => void) | null = null
    private enabled = false
    private registered = false
    private state: GamepadState = emptyGamepadState()
    private lastSent: GamepadState = emptyGamepadState()

    private leftStick: StickState = { active: false, pointerId: null, centerX: 0, centerY: 0, valueX: 0, valueY: 0 }
    private rightStick: StickState = { active: false, pointerId: null, centerX: 0, centerY: 0, valueX: 0, valueY: 0 }

    private buttons: Map<HTMLElement, { name: string, pressed: boolean }> = new Map()

    constructor(input: StreamInput, logDebug?: (message: string) => void) {
        this.input = input
        this.logDebug = logDebug ?? null
        this.root.classList.add("touch-controller")
        this.root.style.display = "none"

        this.buildLayout()
        this.registerController()
    }

    mount(parent: HTMLElement) {
        parent.appendChild(this.root)
    }

    setVisible(visible: boolean) {
        if (visible === this.enabled) {
            return
        }
        this.enabled = visible
        this.root.style.display = visible ? "flex" : "none"

        if (visible) {
            this.logDebug?.("[TouchController] Enabled")
            this.sendState(true)
        } else {
            this.logDebug?.("[TouchController] Disabled")
            this.resetState()
        }
    }

    isVisible(): boolean {
        return this.enabled
    }

    private registerController() {
        if (this.registered) {
            return
        }
        this.registered = true
        this.logDebug?.("[TouchController] Register controller")
        this.input.sendControllerAdd(VIRTUAL_CONTROLLER_ID, SUPPORTED_BUTTONS, 0)
    }

    private resetState() {
        this.state = emptyGamepadState()
        this.lastSent = emptyGamepadState()
        for (const [element, info] of this.buttons) {
            if (info.pressed) {
                info.pressed = false
                element.classList.remove("pressed")
            }
        }
        this.leftStick = { active: false, pointerId: null, centerX: 0, centerY: 0, valueX: 0, valueY: 0 }
        this.rightStick = { active: false, pointerId: null, centerX: 0, centerY: 0, valueX: 0, valueY: 0 }
        this.sendState(true)
    }

    private sendState(force = false) {
        if (!force && this.statesEqual(this.state, this.lastSent)) {
            return
        }
        this.lastSent = { ...this.state }
        this.logDebug?.(`[TouchController] Send state flags=${this.lastSent.buttonFlags} LT=${this.lastSent.leftTrigger.toFixed(2)} RT=${this.lastSent.rightTrigger.toFixed(2)} LX=${this.lastSent.leftStickX.toFixed(2)} LY=${this.lastSent.leftStickY.toFixed(2)} RX=${this.lastSent.rightStickX.toFixed(2)} RY=${this.lastSent.rightStickY.toFixed(2)}`)
        this.input.sendController(VIRTUAL_CONTROLLER_ID, this.lastSent)
    }

    private statesEqual(a: GamepadState, b: GamepadState): boolean {
        return a.buttonFlags === b.buttonFlags
            && a.leftTrigger === b.leftTrigger
            && a.rightTrigger === b.rightTrigger
            && a.leftStickX === b.leftStickX
            && a.leftStickY === b.leftStickY
            && a.rightStickX === b.rightStickX
            && a.rightStickY === b.rightStickY
    }

    private buildLayout() {
        const topRow = document.createElement("div")
        topRow.classList.add("touch-controller-top")

        topRow.appendChild(this.createButton("LT", "lt"))
        topRow.appendChild(this.createButton("LB", "lb"))
        topRow.appendChild(this.createButton("RB", "rb"))
        topRow.appendChild(this.createButton("RT", "rt"))

        const centerRow = document.createElement("div")
        centerRow.classList.add("touch-controller-center")

        const dpad = document.createElement("div")
        dpad.classList.add("touch-controller-dpad")
        dpad.appendChild(this.createButton("▲", "up"))
        const dpadRow = document.createElement("div")
        dpadRow.classList.add("touch-controller-dpad-row")
        dpadRow.appendChild(this.createButton("◀", "left"))
        dpadRow.appendChild(this.createButton("▶", "right"))
        dpad.appendChild(dpadRow)
        dpad.appendChild(this.createButton("▼", "down"))

        const leftStick = this.createStick("left")
        const rightStick = this.createStick("right")

        const face = document.createElement("div")
        face.classList.add("touch-controller-face")
        const faceRowTop = document.createElement("div")
        faceRowTop.classList.add("touch-controller-face-row")
        faceRowTop.appendChild(this.createButton("Y", "y"))
        face.appendChild(faceRowTop)
        const faceRowMid = document.createElement("div")
        faceRowMid.classList.add("touch-controller-face-row")
        faceRowMid.appendChild(this.createButton("X", "x"))
        faceRowMid.appendChild(this.createButton("B", "b"))
        face.appendChild(faceRowMid)
        const faceRowBottom = document.createElement("div")
        faceRowBottom.classList.add("touch-controller-face-row")
        faceRowBottom.appendChild(this.createButton("A", "a"))
        face.appendChild(faceRowBottom)

        const middle = document.createElement("div")
        middle.classList.add("touch-controller-middle")
        middle.appendChild(this.createButton("Back", "back"))
        middle.appendChild(this.createButton("Play", "play"))
        middle.appendChild(this.createButton("LS", "ls"))
        middle.appendChild(this.createButton("RS", "rs"))

        centerRow.appendChild(dpad)
        centerRow.appendChild(leftStick)
        centerRow.appendChild(middle)
        centerRow.appendChild(rightStick)
        centerRow.appendChild(face)

        this.root.appendChild(topRow)
        this.root.appendChild(centerRow)
    }

    private createButton(label: string, name: string): HTMLElement {
        const btn = document.createElement("button")
        btn.classList.add("touch-controller-button")
        btn.dataset.name = name
        btn.textContent = label

        const info = { name, pressed: false }
        this.buttons.set(btn, info)

        const press = () => {
            if (info.pressed) return
            info.pressed = true
            btn.classList.add("pressed")
            this.onButtonChange(info.name, true)
        }
        const release = () => {
            if (!info.pressed) return
            info.pressed = false
            btn.classList.remove("pressed")
            this.onButtonChange(info.name, false)
        }

        btn.addEventListener("pointerdown", (event) => {
            event.preventDefault()
            btn.setPointerCapture(event.pointerId)
            press()
        })
        btn.addEventListener("pointerup", (event) => {
            event.preventDefault()
            release()
        })
        btn.addEventListener("pointercancel", (event) => {
            event.preventDefault()
            release()
        })
        btn.addEventListener("pointerleave", (event) => {
            event.preventDefault()
            if (!btn.hasPointerCapture(event.pointerId)) {
                release()
            }
        })

        return btn
    }

    private onButtonChange(name: string, pressed: boolean) {
        const flag = BUTTON_MAP[name]
        if (flag != null) {
            if (pressed) {
                this.state.buttonFlags |= flag
            } else {
                this.state.buttonFlags &= ~flag
            }
        }

        if (name === "lt") {
            this.state.leftTrigger = pressed ? 1 : 0
        }
        if (name === "rt") {
            this.state.rightTrigger = pressed ? 1 : 0
        }

        this.sendState()
    }

    private createStick(side: "left" | "right"): HTMLElement {
        const stick = document.createElement("div")
        stick.classList.add("touch-controller-stick")
        stick.classList.add(`touch-controller-stick-${side}`)

        const knob = document.createElement("div")
        knob.classList.add("touch-controller-stick-knob")
        stick.appendChild(knob)

        const state = side === "left" ? this.leftStick : this.rightStick

        const updateKnob = () => {
            const radius = 32
            knob.style.transform = `translate(${state.valueX * radius}px, ${state.valueY * radius}px)`
        }

        const onMove = (clientX: number, clientY: number) => {
            const dx = clientX - state.centerX
            const dy = clientY - state.centerY
            const max = 40
            const distance = Math.min(Math.sqrt(dx * dx + dy * dy), max)
            const angle = Math.atan2(dy, dx)

            const normX = (Math.cos(angle) * distance) / max
            const normY = (Math.sin(angle) * distance) / max

            state.valueX = Math.max(-1, Math.min(1, normX))
            state.valueY = Math.max(-1, Math.min(1, normY))
            updateKnob()
            if (side === "left") {
                this.state.leftStickX = state.valueX
                this.state.leftStickY = state.valueY
            } else {
                this.state.rightStickX = state.valueX
                this.state.rightStickY = state.valueY
            }
            this.sendState()
        }

        const release = () => {
            state.active = false
            state.pointerId = null
            state.valueX = 0
            state.valueY = 0
            updateKnob()
            if (side === "left") {
                this.state.leftStickX = 0
                this.state.leftStickY = 0
            } else {
                this.state.rightStickX = 0
                this.state.rightStickY = 0
            }
            this.sendState()
        }

        stick.addEventListener("pointerdown", (event) => {
            event.preventDefault()
            stick.setPointerCapture(event.pointerId)
            const rect = stick.getBoundingClientRect()
            state.centerX = rect.left + rect.width / 2
            state.centerY = rect.top + rect.height / 2
            state.active = true
            state.pointerId = event.pointerId
            onMove(event.clientX, event.clientY)
        })
        stick.addEventListener("pointermove", (event) => {
            if (!state.active || state.pointerId !== event.pointerId) return
            onMove(event.clientX, event.clientY)
        })
        stick.addEventListener("pointerup", (event) => {
            if (state.pointerId !== event.pointerId) return
            release()
        })
        stick.addEventListener("pointercancel", (event) => {
            if (state.pointerId !== event.pointerId) return
            release()
        })

        return stick
    }
}
