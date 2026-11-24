// Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level M, Versions 1-14)

interface QrVersionSpec {
	ver: number;
	ecPerBlock: number;
	g1Blocks: number;
	g1Data: number;
	g2Blocks: number;
	g2Data: number;
}

const QR_M_SPECS: QrVersionSpec[] = [
	{ ver: 1, ecPerBlock: 10, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0 },
	{ ver: 2, ecPerBlock: 16, g1Blocks: 1, g1Data: 28, g2Blocks: 0, g2Data: 0 },
	{ ver: 3, ecPerBlock: 26, g1Blocks: 1, g1Data: 44, g2Blocks: 0, g2Data: 0 },
	{ ver: 4, ecPerBlock: 18, g1Blocks: 2, g1Data: 32, g2Blocks: 0, g2Data: 0 },
	{ ver: 5, ecPerBlock: 24, g1Blocks: 2, g1Data: 43, g2Blocks: 0, g2Data: 0 },
	{ ver: 6, ecPerBlock: 16, g1Blocks: 4, g1Data: 27, g2Blocks: 0, g2Data: 0 },
	{ ver: 7, ecPerBlock: 18, g1Blocks: 4, g1Data: 31, g2Blocks: 0, g2Data: 0 },
	{ ver: 8, ecPerBlock: 22, g1Blocks: 2, g1Data: 38, g2Blocks: 2, g2Data: 39 },
	{ ver: 9, ecPerBlock: 22, g1Blocks: 3, g1Data: 36, g2Blocks: 2, g2Data: 37 },
	{ ver: 10, ecPerBlock: 26, g1Blocks: 4, g1Data: 43, g2Blocks: 1, g2Data: 44 },
	{ ver: 11, ecPerBlock: 30, g1Blocks: 1, g1Data: 50, g2Blocks: 4, g2Data: 51 },
	{ ver: 12, ecPerBlock: 22, g1Blocks: 6, g1Data: 36, g2Blocks: 2, g2Data: 37 },
	{ ver: 13, ecPerBlock: 22, g1Blocks: 8, g1Data: 37, g2Blocks: 1, g2Data: 38 },
	{ ver: 14, ecPerBlock: 24, g1Blocks: 4, g1Data: 40, g2Blocks: 5, g2Data: 41 },
];

const ALIGN_POSITIONS: number[][] = [
	[],
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
	[6, 30, 54],
	[6, 32, 58],
	[6, 34, 62],
	[6, 26, 46, 66],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
	let x = 1;
	for (let i = 0; i < 255; i++) {
		GF_EXP[i] = x;
		GF_LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) {
		GF_EXP[i] = GF_EXP[i - 255];
	}
})();

function gfMul(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree: number): number[] {
	let poly = [1];
	for (let i = 0; i < degree; i++) {
		const next = new Array<number>(poly.length + 1).fill(0);
		const factor = GF_EXP[i];
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j];
			next[j + 1] ^= gfMul(poly[j], factor);
		}
		poly = next;
	}
	return poly;
}

function rsRemainder(data: number[], degree: number): number[] {
	const gen = rsGenerator(degree);
	const res = new Array<number>(degree).fill(0);
	for (const b of data) {
		const factor = b ^ res[0];
		res.shift();
		res.push(0);
		for (let j = 0; j < degree; j++) {
			res[j] ^= gfMul(gen[j + 1], factor);
		}
	}
	return res;
}

function formatBitsM(mask: number): number {
	const data = mask & 7;
	let rem = data << 10;
	for (let i = 4; i >= 0; i--) {
		if ((rem >> (i + 10)) & 1) {
			rem ^= 0x537 << i;
		}
	}
	return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
	let rem = version << 12;
	for (let i = 5; i >= 0; i--) {
		if ((rem >> (i + 12)) & 1) {
			rem ^= 0x1f25 << i;
		}
	}
	return (version << 12) | rem;
}

function encodeQrMatrix(text: string): boolean[][] {
	const bytes = Array.from(new TextEncoder().encode(text));
	const n = bytes.length;

	let spec: QrVersionSpec | null = null;
	for (const candidate of QR_M_SPECS) {
		const dataCap = candidate.g1Blocks * candidate.g1Data + candidate.g2Blocks * candidate.g2Data;
		const ccBits = candidate.ver <= 9 ? 8 : 16;
		if (4 + ccBits + n * 8 <= dataCap * 8) {
			spec = candidate;
			break;
		}
	}
	if (!spec) {
		throw new Error("Pairing URI exceeds QR capacity.");
	}

	const dataCap = spec.g1Blocks * spec.g1Data + spec.g2Blocks * spec.g2Data;
	const ccBits = spec.ver <= 9 ? 8 : 16;

	const bits: number[] = [];
	const pushBits = (val: number, count: number) => {
		for (let i = count - 1; i >= 0; i--) {
			bits.push((val >> i) & 1);
		}
	};

	pushBits(0b0100, 4);
	pushBits(n, ccBits);
	for (const b of bytes) {
		pushBits(b, 8);
	}
	pushBits(0, Math.min(4, dataCap * 8 - bits.length));
	while (bits.length % 8 !== 0) {
		bits.push(0);
	}

	const codewords: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let val = 0;
		for (let j = 0; j < 8; j++) {
			val = (val << 1) | bits[i + j];
		}
		codewords.push(val);
	}

	let padIdx = 0;
	while (codewords.length < dataCap) {
		codewords.push(padIdx % 2 === 0 ? 0xec : 0x11);
		padIdx++;
	}

	const blocks: number[][] = [];
	const ecBlocks: number[][] = [];
	let offset = 0;
	for (let i = 0; i < spec.g1Blocks; i++) {
		const blk = codewords.slice(offset, offset + spec.g1Data);
		blocks.push(blk);
		ecBlocks.push(rsRemainder(blk, spec.ecPerBlock));
		offset += spec.g1Data;
	}
	for (let i = 0; i < spec.g2Blocks; i++) {
		const blk = codewords.slice(offset, offset + spec.g2Data);
		blocks.push(blk);
		ecBlocks.push(rsRemainder(blk, spec.ecPerBlock));
		offset += spec.g2Data;
	}

	const interleaved: number[] = [];
	const maxDataLen = Math.max(spec.g1Data, spec.g2Data);
	for (let i = 0; i < maxDataLen; i++) {
		for (const blk of blocks) {
			if (i < blk.length) interleaved.push(blk[i]);
		}
	}
	for (let i = 0; i < spec.ecPerBlock; i++) {
		for (const ec of ecBlocks) {
			interleaved.push(ec[i]);
		}
	}

	const size = spec.ver * 4 + 17;
	const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const isFunc: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

	const setFunc = (r: number, c: number, dark: boolean) => {
		modules[r][c] = dark;
		isFunc[r][c] = true;
	};

	const drawFinder = (r0: number, c0: number) => {
		for (let dr = -1; dr <= 7; dr++) {
			for (let dc = -1; dc <= 7; dc++) {
				const r = r0 + dr;
				const c = c0 + dc;
				if (r >= 0 && r < size && c >= 0 && c < size) {
					const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
					setFunc(r, c, dist !== 2 && dist !== 4);
				}
			}
		}
	};

	const drawAlign = (cr: number, cc: number) => {
		for (let dr = -2; dr <= 2; dr++) {
			for (let dc = -2; dc <= 2; dc++) {
				const dist = Math.max(Math.abs(dr), Math.abs(dc));
				setFunc(cr + dr, cc + dc, dist !== 1);
			}
		}
	};

	for (let i = 0; i < size; i++) {
		setFunc(6, i, i % 2 === 0);
		setFunc(i, 6, i % 2 === 0);
	}

	drawFinder(0, 0);
	drawFinder(0, size - 7);
	drawFinder(size - 7, 0);

	const pos = ALIGN_POSITIONS[spec.ver];
	for (let i = 0; i < pos.length; i++) {
		for (let j = 0; j < pos.length; j++) {
			if (
				(i === 0 && j === 0) ||
				(i === 0 && j === pos.length - 1) ||
				(i === pos.length - 1 && j === 0)
			) {
				continue;
			}
			drawAlign(pos[i], pos[j]);
		}
	}

	for (let i = 0; i < 9; i++) {
		if (i !== 6) {
			setFunc(8, i, false);
			setFunc(i, 8, false);
		}
	}
	for (let i = 0; i < 8; i++) {
		setFunc(8, size - 1 - i, false);
		setFunc(size - 1 - i, 8, false);
	}
	setFunc(size - 8, 8, true);

	if (spec.ver >= 7) {
		const vbits = versionBits(spec.ver);
		for (let i = 0; i < 18; i++) {
			const bit = ((vbits >> i) & 1) === 1;
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			setFunc(a, b, bit);
			setFunc(b, a, bit);
		}
	}

	let bitIdx = 0;
	const totalBits = interleaved.length * 8;
	let up = true;
	for (let col = size - 1; col > 0; col -= 2) {
		if (col === 6) col--;
		for (let step = 0; step < size; step++) {
			const r = up ? size - 1 - step : step;
			for (let dc = 0; dc >= -1; dc--) {
				const c = col + dc;
				if (!isFunc[r][c]) {
					let dark = false;
					if (bitIdx < totalBits) {
						dark = ((interleaved[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) === 1;
						bitIdx++;
					}
					modules[r][c] = dark;
				}
			}
		}
		up = !up;
	}

	const maskCond = (m: number, r: number, c: number): boolean => {
		switch (m) {
			case 0: return (r + c) % 2 === 0;
			case 1: return r % 2 === 0;
			case 2: return c % 3 === 0;
			case 3: return (r + c) % 3 === 0;
			case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
			case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
			case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
			default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
		}
	};

	const drawFormat = (mat: boolean[][], mask: number) => {
		const fb = formatBitsM(mask);
		for (let i = 0; i < 6; i++) {
			mat[8][i] = ((fb >> (14 - i)) & 1) === 1;
		}
		mat[8][7] = ((fb >> 8) & 1) === 1;
		mat[8][8] = ((fb >> 7) & 1) === 1;
		mat[7][8] = ((fb >> 6) & 1) === 1;
		for (let i = 0; i < 6; i++) {
			mat[5 - i][8] = ((fb >> (5 - i)) & 1) === 1;
		}
		for (let i = 0; i < 7; i++) {
			mat[size - 1 - i][8] = ((fb >> (14 - i)) & 1) === 1;
		}
		for (let i = 0; i < 8; i++) {
			mat[8][size - 1 - i] = ((fb >> i) & 1) === 1;
		}
	};

	const penalty = (mat: boolean[][]): number => {
		let score = 0;
		for (let r = 0; r < size; r++) {
			let run = 1;
			for (let c = 1; c < size; c++) {
				if (mat[r][c] === mat[r][c - 1]) {
					run++;
				} else {
					if (run >= 5) score += run - 2;
					run = 1;
				}
			}
			if (run >= 5) score += run - 2;
		}
		for (let c = 0; c < size; c++) {
			let run = 1;
			for (let r = 1; r < size; r++) {
				if (mat[r][c] === mat[r - 1][c]) {
					run++;
				} else {
					if (run >= 5) score += run - 2;
					run = 1;
				}
			}
			if (run >= 5) score += run - 2;
		}
		for (let r = 0; r < size - 1; r++) {
			for (let c = 0; c < size - 1; c++) {
				const v = mat[r][c];
				if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) {
					score += 3;
				}
			}
		}
		return score;
	};

	let bestMat: boolean[][] = modules;
	let bestPen = Number.MAX_SAFE_INTEGER;
	for (let m = 0; m < 8; m++) {
		const cand = modules.map((row) => row.slice());
		for (let r = 0; r < size; r++) {
			for (let c = 0; c < size; c++) {
				if (!isFunc[r][c] && maskCond(m, r, c)) {
					cand[r][c] = !cand[r][c];
				}
			}
		}
		drawFormat(cand, m);
		const p = penalty(cand);
		if (p < bestPen) {
			bestPen = p;
			bestMat = cand;
		}
	}

	return bestMat;
}

export function createQrSvgElement(text: string): SVGSVGElement {
	const matrix = encodeQrMatrix(text);
	const count = matrix.length;
	const quiet = 4;
	const size = count + quiet * 2;

	let pathData = "";
	for (let r = 0; r < count; r++) {
		for (let c = 0; c < count; c++) {
			if (matrix[r][c]) {
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
