import { expect, test } from 'vitest';
import { AudioResampler } from '../../src/resample.js';
import { AudioSample } from '../../src/sample.js';

test('Output buffer boundary with fractional chunk endpoint', async () => {
	const output: number[] = [];
	const outputLengths: number[] = [];
	const resampler = new AudioResampler({
		targetSampleRate: 12,
		targetNumberOfChannels: 1,
		onSample: async (sample) => {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			output.push(...data);
			outputLengths.push(sample.numberOfFrames);
			sample.close();
		},
	});

	// Shift the following chunks by half an output frame so the second ends at 60.5
	const samples = [
		{ frames: 1, timestamp: 0 },
		{ frames: 19, timestamp: 3.5 / 12 },
		{ frames: 4, timestamp: 60.5 / 12 },
	].map(({ frames, timestamp }) => new AudioSample({
		format: 'f32',
		sampleRate: 4,
		numberOfChannels: 1,
		timestamp,
		data: new Float32Array(frames).fill(0.75),
	}));

	expect((samples[1]!.timestamp + samples[1]!.duration) * 12).toBe(60.5);

	for (const sample of samples) {
		await resampler.add(sample);
		sample.close();
	}
	await resampler.finalize();

	expect(outputLengths).toEqual([60, 13]);
	expect(output.slice(58, 63)).toEqual([0.75, 0.75, 0.75, 0.75, 0.75]);
});

test.each([false, true])('Accumulated chunk durations (microsecond-rounded: %s)', async (rounded) => {
	let outputFrames = 0;
	const resampler = new AudioResampler({
		targetSampleRate: 48000,
		targetNumberOfChannels: 1,
		onSample: async (sample) => {
			outputFrames += sample.numberOfFrames;
			sample.close();
		},
	});

	let timestamp = 0;
	for (let framesLeft = 44100 * 6; framesLeft > 0; framesLeft -= 1152) {
		const sample = new AudioSample({
			format: 'f32',
			sampleRate: 44100,
			numberOfChannels: 1,
			timestamp: rounded ? Math.round(timestamp * 1e6) / 1e6 : timestamp,
			data: new Float32Array(Math.min(1152, framesLeft)),
		});
		await resampler.add(sample);
		timestamp += sample.duration;
		sample.close();
	}
	await resampler.finalize();

	expect(timestamp).toBeGreaterThan(6); // Accumulated durations leave a floating-point tail.
	expect(outputFrames).toBe(48000 * 6);
});
