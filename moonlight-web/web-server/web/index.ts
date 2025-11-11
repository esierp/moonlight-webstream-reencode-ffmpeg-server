import { Api, getApi, apiPostHost, FetchError, apiLogout, apiGetUser } from "./api.js";
import { AddHostModal } from "./component/host/add_modal.js";
import { HostList } from "./component/host/list.js";
import { Component, ComponentEvent } from "./component/index.js";
import { showErrorPopup } from "./component/error.js";
import { showModal } from "./component/modal/index.js";
import { setContextMenu } from "./component/context_menu.js";
import { GameList } from "./component/game/list.js";
import { Host } from "./component/host/index.js";
import { App, DetailedUser } from "./api_bindings.js";
import { getLocalStreamSettings, setLocalStreamSettings, StreamSettingsComponent } from "./component/settings_menu.js";
import { setTouchContextMenuEnabled } from "./ios_right_click.js";
import { buildUrl } from "./config_.js";

async function startApp() {
    setTouchContextMenuEnabled(true)

    const api = await getApi()

    const rootElement = document.getElementById("root");
    if (rootElement == null) {
        showErrorPopup("couldn't find root element", true)
        return;
    }

    const app = new MainApp(api)
    app.mount(rootElement)

    app.forceFetch()

    window.addEventListener("popstate", event => {
        app.setAppState(event.state)
    })
}

startApp()

type DisplayStates = "hosts" | "games" | "settings"

type AppState = { display: DisplayStates, hostId?: number }
function pushAppState(state: AppState) {
    history.pushState(state, "")
}

class MainApp implements Component {
    private api: Api
    private user: DetailedUser | null = null

    private divElement = document.createElement("div")

    // Top Line
    private topLine = document.createElement("div")

    private moonlightTextElement = document.createElement("h1")

    private topLineActions = document.createElement("div")
    private logoutButton = document.createElement("button")
    private adminButton = document.createElement("button")

    // Actions
    private actionElement = document.createElement("div")

    private backToHostsButton: HTMLButtonElement = document.createElement("button")

    private hostAddButton: HTMLButtonElement = document.createElement("button")
    private settingsButton: HTMLButtonElement = document.createElement("button")

    // Different submenus
    private currentDisplay: DisplayStates | null = null

    private hostList: HostList
    private gameList: GameList | null = null
    private settings: StreamSettingsComponent

    constructor(api: Api) {
        this.api = api

        // Top Line
        this.topLine.classList.add("top-line")

        this.moonlightTextElement.innerHTML = "Moonlight Web"
        this.topLine.appendChild(this.moonlightTextElement)

        this.topLine.appendChild(this.topLineActions)
        this.topLineActions.classList.add("top-line-actions")

        this.logoutButton.addEventListener("click", async () => {
            await apiLogout(this.api)
            window.location.reload()
        })
        this.logoutButton.classList.add("logout-button")
        this.topLineActions.appendChild(this.logoutButton)

        this.adminButton.addEventListener("click", async () => {
            window.location.href = buildUrl("/admin.html")
        })
        this.adminButton.classList.add("admin-button")

        // Actions
        this.actionElement.classList.add("actions-list")

        // Back button
        this.backToHostsButton.innerText = "Back"
        this.backToHostsButton.addEventListener("click", () => this.setCurrentDisplay("hosts"))

        // Host add button
        this.hostAddButton.classList.add("host-add")
        this.hostAddButton.addEventListener("click", this.addHost.bind(this))

        // Host list
        this.hostList = new HostList(api)
        this.hostList.addHostOpenListener(this.onHostOpen.bind(this))

        // Settings Button
        this.settingsButton.classList.add("open-settings")
        this.settingsButton.addEventListener("click", () => this.setCurrentDisplay("settings"))

        // Settings
        this.settings = new StreamSettingsComponent(getLocalStreamSettings() ?? undefined)
        this.settings.addChangeListener(this.onSettingsChange.bind(this))

        // Append default elements
        this.divElement.appendChild(this.topLine)
        this.divElement.appendChild(this.actionElement)

        this.setCurrentDisplay("hosts")

        // Context Menu
        document.body.addEventListener("contextmenu", this.onContextMenu.bind(this), { passive: false })
    }

    setAppState(state: AppState) {
        if (state.display == "hosts") {
            this.setCurrentDisplay("hosts")
        } else if (state.display == "games" && state.hostId != null) {
            this.setCurrentDisplay("games", state.hostId)
        } else if (state.display == "settings") {
            this.setCurrentDisplay("settings")
        }
    }

    private async addHost() {
        const modal = new AddHostModal()

        let host = await showModal(modal);

        if (host) {
            let newHost
            try {
                newHost = await apiPostHost(this.api, host)
            } catch (e) {
                if (e instanceof FetchError) {
                    const response = e.getResponse()
                    if (response && response.status == 400) {
                        showErrorPopup("couldn't add host: not found")
                        return
                    }
                }
                throw e
            }

            this.hostList.insertList(newHost.host_id, newHost)
        }
    }

    private onContextMenu(event: MouseEvent) {
        if (this.currentDisplay == "hosts" || this.currentDisplay == "games") {
            const elements = [
                {
                    name: "Reload",
                    callback: this.forceFetch.bind(this)
                }
            ]

            setContextMenu(event, {
                elements
            })
        }
    }

    private async onHostOpen(event: ComponentEvent<Host>) {
        const hostId = event.component.getHostId()

        this.setCurrentDisplay("games", hostId)
    }

    private onSettingsChange() {
        const newSettings = this.settings.getStreamSettings()

        setLocalStreamSettings(newSettings)
    }

    private setCurrentDisplay(display: "hosts"): void
    private setCurrentDisplay(display: "games", hostId: number, hostCache?: Array<App>): void
    private setCurrentDisplay(display: "settings"): void

    private setCurrentDisplay(display: "hosts" | "games" | "settings", hostId?: number | null, hostCache?: Array<App>) {
        if (display == "games" && hostId == null) {
            // invalid input state
            return
        }

        // Check if we need to change
        if (this.currentDisplay == display) {
            if (this.currentDisplay == "games" && this.gameList?.getHostId() != hostId) {
                // fall through
            } else {
                return
            }
        }

        // Unmount the current display
        if (this.currentDisplay == "hosts") {
            this.actionElement.removeChild(this.hostAddButton)
            this.actionElement.removeChild(this.settingsButton)

            this.hostList.unmount(this.divElement)
        } else if (this.currentDisplay == "games") {
            this.actionElement.removeChild(this.backToHostsButton)

            this.gameList?.unmount(this.divElement)
        } else if (this.currentDisplay == "settings") {
            this.actionElement.removeChild(this.backToHostsButton)

            this.settings.unmount(this.divElement)
        }

        // Mount the new display
        if (display == "hosts") {
            this.actionElement.appendChild(this.hostAddButton)
            this.actionElement.appendChild(this.settingsButton)

            this.hostList.mount(this.divElement)

            pushAppState({ display: "hosts" })
        } else if (display == "games" && hostId != null) {
            this.actionElement.appendChild(this.backToHostsButton)

            if (this.gameList?.getHostId() != hostId) {
                this.gameList = new GameList(this.api, hostId, hostCache ?? null)
                this.gameList.addForceReloadListener(this.forceFetch.bind(this))
            }

            this.gameList.mount(this.divElement)

            this.refreshGameListActiveGame()

            pushAppState({ display: "games", hostId: this.gameList?.getHostId() })
        } else if (display == "settings") {
            this.actionElement.appendChild(this.backToHostsButton)

            this.settings.mount(this.divElement)

            pushAppState({ display: "settings" })
        }

        this.currentDisplay = display
    }

    async forceFetch() {
        const promiseUser = this.refreshUserRole()

        await Promise.all([
            this.hostList.forceFetch(),
            this.gameList?.forceFetch(true)
        ])

        if (this.currentDisplay == "games"
            && this.gameList
            && !this.hostList.getHost(this.gameList.getHostId())) {
            // The newly fetched list doesn't contain the hosts game view we're in -> go to hosts
            this.setCurrentDisplay("hosts")
        }

        await Promise.all([
            promiseUser,
            this.refreshGameListActiveGame()
        ])
    }
    private async refreshUserRole() {
        this.user = await apiGetUser(this.api, {
            // This will get it for the current user
            name: null,
            user_id: null,
        })

        const hasAdminButton = this.topLineActions.contains(this.adminButton)
        if ((this.user.role == "Admin") && !hasAdminButton) {
            this.topLineActions.appendChild(this.adminButton)
        }
        if (this.user.role != "Admin" && hasAdminButton) {
            this.topLineActions.removeChild(this.adminButton)
        }
    }
    private async refreshGameListActiveGame() {
        const gameList = this.gameList
        const hostId = gameList?.getHostId()
        if (hostId == null) {
            return
        }

        const host = this.hostList.getHost(hostId)
        if (host == null) {
            return
        }

        const currentGame = await host.getCurrentGame()
        if (currentGame != null) {
            gameList?.setActiveGame(currentGame)
        } else {
            gameList?.setActiveGame(null)
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }
}