/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

type RawAudioEncoderMetrics = Readonly<{
	frameCount: number;
	sampleRate: number;
}>;

const rawAudioEncoderMetrics = new WeakMap<object, {
	frameCount: number;
	sampleRate: number;
}>();

export const recordRawAudioEncoderFrames = (source: object, frameCount: number, sampleRate: number) => {
	let metrics = rawAudioEncoderMetrics.get(source);
	if (!metrics) {
		metrics = { frameCount: 0, sampleRate };
		rawAudioEncoderMetrics.set(source, metrics);
	}

	metrics.frameCount += frameCount;
};

export const getRawAudioEncoderMetrics = (source: object): RawAudioEncoderMetrics | null => {
	return rawAudioEncoderMetrics.get(source) ?? null;
};
