import { useEffect, useRef } from "react";

function drawRoundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
) {
	const r = Math.min(radius, width / 2, height / 2);
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + width - r, y);
	ctx.quadraticCurveTo(x + width, y, x + width, y + r);
	ctx.lineTo(x + width, y + height - r);
	ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
	ctx.lineTo(x + r, y + height);
	ctx.quadraticCurveTo(x, y + height, x, y + height - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
}

function sampleRange(data: Uint8Array, start: number, end: number) {
	let total = 0;
	const safeEnd = Math.max(start + 1, end);
	for (let i = start; i < safeEnd; i++) total += data[i] ?? 0;
	return total / Math.max(1, safeEnd - start) / 255;
}

export function VoiceWaveform({ analyser }: { analyser: AnalyserNode }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const element = canvas;
		const context = ctx;
		const freqData = new Uint8Array(analyser.frequencyBinCount);
		let animationId = 0;
		let phase = 0;
		let smoothedVolume = 0;
		let canvasWidth = 0;
		let canvasHeight = 0;
		let canvasDpr = 0;

		function draw() {
			animationId = requestAnimationFrame(draw);
			analyser.getByteFrequencyData(freqData);

			const dpr = window.devicePixelRatio || 1;
			const width = element.clientWidth;
			const height = element.clientHeight;

			if (width !== canvasWidth || height !== canvasHeight || dpr !== canvasDpr) {
				canvasWidth = width;
				canvasHeight = height;
				canvasDpr = dpr;
				element.width = width * dpr;
				element.height = height * dpr;
				context.setTransform(dpr, 0, 0, dpr, 0, 0);
			}

			context.clearRect(0, 0, width, height);

			let total = 0;
			for (let i = 0; i < freqData.length; i++) total += freqData[i] ?? 0;
			const avgVolume = total / freqData.length / 255;
			smoothedVolume = smoothedVolume * 0.88 + avgVolume * 0.12;
			phase += 0.025;

			const isMobile = width < 420;
			const barCount = isMobile ? 26 : 32;
			const sidePadding = isMobile ? 6 : 10;
			const gap = isMobile ? 5 : 6;
			const availableWidth = width - sidePadding * 2;
			const barWidth = Math.max(2.5, (availableWidth - gap * (barCount - 1)) / barCount);
			const baseline = height - 3;
			const maxBarHeight = height - 6;
			const minBarHeight = 4;
			const radius = Math.min(2.5, barWidth / 2);

			context.shadowColor = "rgba(255, 255, 255, 0.06)";
			context.shadowBlur = 6;

			for (let i = 0; i < barCount; i++) {
				const t = i / Math.max(1, barCount - 1);
				const x = sidePadding + i * (barWidth + gap);

				const binStart = Math.floor(t * Math.min(freqData.length * 0.5, 96));
				const binEnd = Math.floor((t + 1 / barCount) * Math.min(freqData.length * 0.5, 96));
				const signal = sampleRange(freqData, binStart, binEnd);

				const hillA = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2.1 + phase * 0.7)), 2.1);
				const hillB = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2.1 + phase * 0.7 + 1.8)), 2.1);
				const movingShape = Math.max(hillA, hillB);
				const microPulse = (Math.sin(phase * 1.4 + i * 0.56) + 1) / 2;
				const level = Math.max(
					0.05 + microPulse * 0.03,
					movingShape * (0.18 + smoothedVolume * 0.18) + signal * (0.95 + smoothedVolume * 0.35),
				);

				const barHeight = Math.max(
					minBarHeight,
					Math.min(maxBarHeight, minBarHeight + level * (maxBarHeight - minBarHeight)),
				);
				const y = baseline - barHeight;
				const alpha = 0.28 + Math.min(0.42, level * 0.34);

				const gradient = context.createLinearGradient(0, y, 0, baseline);
				gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.95})`);
				gradient.addColorStop(1, `rgba(148, 163, 184, ${alpha})`);
				context.fillStyle = gradient;

				drawRoundedRect(context, x, y, barWidth, barHeight, radius);
				context.fill();
			}

			context.shadowColor = "transparent";
			context.shadowBlur = 0;
		}

		draw();
		return () => cancelAnimationFrame(animationId);
	}, [analyser]);

	return <canvas ref={canvasRef} className="h-[56px] w-full md:h-[68px]" />;
}
