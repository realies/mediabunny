/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { aacFrequencyTable, parseAacAudioSpecificConfig } from '../shared/aac-misc';
import { readMp3FrameHeader } from '../shared/mp3-misc';
import { AudioCodec, parsePcmCodec, PCM_AUDIO_CODECS, PcmAudioCodec } from './codec';
import { AC3_FRAME_SIZES, EAC3_NUMBLKS_TABLE, parseDtsFrame, parseOpusTocByte } from './codec-data';
import { getBlockSizeOrUncommon, readBlockSize, readCodedNumber } from './flac/flac-misc';
import { AsyncMutex, toDataView, toUint8Array } from './misc';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from './output';
import { EncodedPacket } from './packet';
import { FileSlice } from './reader';
import { SubtitleCue, SubtitleMetadata } from './subtitles';

export abstract class Muxer {
	output: Output;
	mutex = new AsyncMutex();

	constructor(output: Output) {
		this.output = output;
	}

	abstract start(): Promise<void>;
	abstract getMimeType(): Promise<string>;
	abstract addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata
	): Promise<void>;
	abstract addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata
	): Promise<void>;
	abstract addSubtitleCue(track: OutputSubtitleTrack, cue: SubtitleCue, meta?: SubtitleMetadata): Promise<void>;
	abstract finalize(): Promise<void>;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	onTrackClose(track: OutputTrack) {}

	private trackTimestampInfo = new WeakMap<OutputTrack, {
		maxTimestamp: number;
		maxTimestampBeforeLastKeyPacket: number | null;
	}>();

	protected validateTimestamp(track: OutputTrack, timestampInSeconds: number, isKeyPacket: boolean) {
		let timestampInfo = this.trackTimestampInfo.get(track);
		if (!timestampInfo) {
			if (!isKeyPacket) {
				throw new Error('First packet must be a key packet.');
			}

			timestampInfo = {
				maxTimestamp: timestampInSeconds,
				maxTimestampBeforeLastKeyPacket: null,
			};
			this.trackTimestampInfo.set(track, timestampInfo);
		} else {
			if (isKeyPacket) {
				timestampInfo.maxTimestampBeforeLastKeyPacket = timestampInfo.maxTimestamp;
			}

			if (
				timestampInfo.maxTimestampBeforeLastKeyPacket !== null
				&& timestampInSeconds < timestampInfo.maxTimestampBeforeLastKeyPacket
			) {
				throw new Error(
					`Timestamps cannot be smaller than the largest timestamp of the previous GOP (a GOP begins with a`
					+ ` key packet and ends right before the next key packet). Got ${timestampInSeconds}s, but largest`
					+ ` timestamp is ${timestampInfo.maxTimestampBeforeLastKeyPacket}s.`,
				);
			}

			timestampInfo.maxTimestamp = Math.max(timestampInfo.maxTimestamp, timestampInSeconds);
		}
	}
}

/**
 * Counts the samples an audio packet decodes to from the codec's own framing, because a container may round the
 * duration it reports. Opus counts at 48 kHz, every other codec at the decoder config's sample rate. Throws rather than
 * return a count that might be wrong.
 */
export const getAudioPacketSampleCount = (codec: AudioCodec, data: Uint8Array, decoderConfig: AudioDecoderConfig) => {
	let count: number | null = null;

	if (codec === 'opus') {
		count = parseOpusTocByte(data).durationInSamples;
	} else if (codec === 'aac') {
		// With SBR, a frame decodes to more samples than the core coder's frame length, at a proportionally higher rate
		const config = parseAacAudioSpecificConfig(
			decoderConfig.description ? toUint8Array(decoderConfig.description) : null,
		);
		const coreSampleRate = aacFrequencyTable[config.frequencyIndex];
		if (config.frameLength !== null && coreSampleRate !== undefined) {
			count = config.frameLength * decoderConfig.sampleRate / coreSampleRate;
		}
	} else if (codec === 'mp3') {
		if (data.byteLength >= 4) {
			const header = readMp3FrameHeader(toDataView(data).getUint32(0, false), data.byteLength).header;
			count = header?.audioSamplesInFrame ?? null;
		}
	} else if (codec === 'flac') {
		// Two of the block size codes store the size after the frame number, which is coded in one to seven bytes
		const blockSizeOrUncommon = data.byteLength >= 6 && data[0] === 0xff && (data[1]! & 0xfe) === 0xf8
			? getBlockSizeOrUncommon(data[2]! >> 4)
			: null;
		if (blockSizeOrUncommon !== null) {
			const slice = FileSlice.tempFromBytes(data);
			slice.skip(4);
			readCodedNumber(slice);
			count = readBlockSize(slice, blockSizeOrUncommon);
		}
	} else if (codec === 'ac3' || codec === 'eac3') {
		// A packet can hold several syncframes, dependent substreams among them. An AC-3 syncframe decodes six
		// blocks of 256 samples, and an E-AC-3 syncframe of independent substream 0 the block count in its header.
		let blocks = 0;
		let pos = 0;
		while (pos + 6 <= data.byteLength && data[pos] === 0x0b && data[pos + 1] === 0x77) {
			const fscod = data[pos + 4]! >> 6;
			if (data[pos + 5]! >> 3 <= 10) {
				const frameSize = fscod === 3 ? undefined : AC3_FRAME_SIZES[3 * (data[pos + 4]! & 0x3f) + fscod];
				if (frameSize === undefined) {
					break;
				}

				blocks += 6;
				pos += frameSize;
			} else {
				if (data[pos + 2]! >> 6 !== 1 && (data[pos + 2]! & 0x38) === 0) {
					blocks += fscod === 3 ? 6 : EAC3_NUMBLKS_TABLE[(data[pos + 4]! >> 4) & 0x3]!;
				}

				pos += 2 * ((((data[pos + 2]! & 0x7) << 8) | data[pos + 3]!) + 1);
			}
		}

		if (pos === data.byteLength) {
			count = 256 * blocks;
		}
	} else if (codec === 'dts') {
		// The frame's sample count is at the core's rate, which an extension can raise
		const frame = parseDtsFrame(data);
		if (frame?.frameSize === data.byteLength) {
			count = frame.sampleCount * decoderConfig.sampleRate / frame.sampleRate;
		}
	} else if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
		const { sampleSize } = parsePcmCodec(codec as PcmAudioCodec);
		count = data.byteLength / (sampleSize * decoderConfig.numberOfChannels);
	} else {
		throw new TypeError(`Exact audio presentation is not supported for ${codec}.`);
	}

	if (count === null || !Number.isInteger(count)) {
		throw new TypeError(`Could not read an exact sample count from this ${codec} packet.`);
	}

	return count;
};
