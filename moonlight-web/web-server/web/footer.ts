import { BUILD_COMMIT, BUILD_TIME } from "./build_info.js"

export function addFooter() {
    const footer = document.createElement("div")
    footer.classList.add("build-footer")

    const commit = BUILD_COMMIT?.trim() || "unknown"
    const time = BUILD_TIME?.trim() || "unknown"
    footer.innerText = `Build ${commit} @ ${time}`

    document.body.appendChild(footer)
}
