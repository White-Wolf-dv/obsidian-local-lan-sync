import qrcode from "qrcode-generator";

export function createQrSvgElement(text: string): SVGSVGElement {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();

	const count = qr.getModuleCount();
	const quiet = 4;
	const size = count + quiet * 2;

	let pathData = "";
	for (let r = 0; r < count; r++) {
		for (let c = 0; c < count; c++) {
			if (qr.isDark(r, c)) {
				pathData += `M${c + quiet},${r + quiet}h1v1h-1z`;
			}
		}
	}

	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
	svg.setAttribute("shape-rendering", "crispEdges");
	svg.classList.add("local-sync-qr-svg");

	const bg = document.createElementNS(ns, "rect");
	bg.setAttribute("width", String(size));
	bg.setAttribute("height", String(size));
	bg.setAttribute("fill", "#ffffff");
	svg.appendChild(bg);

	const path = document.createElementNS(ns, "path");
	path.setAttribute("d", pathData);
	path.setAttribute("fill", "#000000");
	svg.appendChild(path);

	return svg;
}
