/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ITelemetryLogger } from "@fluidframework/common-definitions";
import { IContainerContext } from "@fluidframework/container-definitions";
import { GenericError } from "@fluidframework/container-utils";
import { MessageType } from "@fluidframework/protocol-definitions";
import { ICompressionRuntimeOptions } from "../containerRuntime";
import { PendingStateManager } from "../pendingStateManager";
import { BatchManager } from "./batchManager";
import { BatchMessage, IBatch } from "./definitions";
import { OpCompressor } from "./opCompressor";
import { OpSplitter } from "./opSplitter";

export interface IOutboxConfig {
	readonly compressionOptions: ICompressionRuntimeOptions;
	// The maximum size of a batch that we can send over the wire.
	readonly maxBatchSizeInBytes: number;
	readonly enableOpReentryCheck?: boolean;
}

export interface IOutboxParameters {
	readonly shouldSend: () => boolean;
	readonly pendingStateManager: PendingStateManager;
	readonly containerContext: IContainerContext;
	readonly config: IOutboxConfig;
	readonly compressor: OpCompressor;
	readonly splitter: OpSplitter;
	readonly logger: ITelemetryLogger;
}

export class Outbox {
	private readonly attachFlowBatch: BatchManager;
	private readonly mainBatch: BatchManager;
	private readonly defaultAttachFlowSoftLimitInBytes = 64 * 1024;

	constructor(private readonly params: IOutboxParameters) {
		const isCompressionEnabled =
			this.params.config.compressionOptions.minimumBatchSizeInBytes !==
			Number.POSITIVE_INFINITY;
		// We need to allow infinite size batches if we enable compression
		const hardLimit = isCompressionEnabled ? Infinity : this.params.config.maxBatchSizeInBytes;
		const softLimit = isCompressionEnabled ? Infinity : this.defaultAttachFlowSoftLimitInBytes;

		this.attachFlowBatch = new BatchManager(
			{
				hardLimit,
				softLimit,
				enableOpReentryCheck: params.config.enableOpReentryCheck,
			},
			params.logger,
		);
		this.mainBatch = new BatchManager(
			{
				hardLimit,
				enableOpReentryCheck: params.config.enableOpReentryCheck,
			},
			params.logger,
		);
	}

	public get isEmpty(): boolean {
		return this.attachFlowBatch.length === 0 && this.mainBatch.length === 0;
	}

	public submit(message: BatchMessage) {
		if (!this.mainBatch.push(message)) {
			throw new GenericError("BatchTooLarge", /* error */ undefined, {
				opSize: message.contents?.length ?? 0,
				batchSize: this.mainBatch.contentSizeInBytes,
				count: this.mainBatch.length,
				limit: this.mainBatch.options.hardLimit,
			});
		}
	}

	public submitAttach(message: BatchMessage) {
		if (!this.attachFlowBatch.push(message)) {
			// BatchManager has two limits - soft limit & hard limit. Soft limit is only engaged
			// when queue is not empty.
			// Flush queue & retry. Failure on retry would mean - single message is bigger than hard limit
			this.flushInternal(this.attachFlowBatch.popBatch());
			if (!this.attachFlowBatch.push(message)) {
				throw new GenericError("BatchTooLarge", /* error */ undefined, {
					opSize: message.contents?.length ?? 0,
					batchSize: this.attachFlowBatch.contentSizeInBytes,
					count: this.attachFlowBatch.length,
					limit: this.attachFlowBatch.options.hardLimit,
				});
			}
		}

		// If compression is enabled, we will always successfully receive
		// attach ops and compress then send them at the next JS turn, regardless
		// of the overall size of the accumulated ops in the batch.
		// However, it is more efficient to flush these ops faster, preferably
		// after they reach a size which would benefit from compression.
		if (
			this.attachFlowBatch.contentSizeInBytes >=
			this.params.config.compressionOptions.minimumBatchSizeInBytes
		) {
			this.flushInternal(this.attachFlowBatch.popBatch());
		}
	}

	public flush() {
		this.flushInternal(this.attachFlowBatch.popBatch());
		this.flushInternal(this.mainBatch.popBatch());
	}

	private flushInternal(rawBatch: IBatch) {
		const processedBatch = this.compressBatch(rawBatch);
		this.sendBatch(processedBatch);

		this.persistBatch(rawBatch.content);
	}

	private compressBatch(batch: IBatch): IBatch {
		if (
			batch.content.length === 0 ||
			this.params.config.compressionOptions === undefined ||
			this.params.config.compressionOptions.minimumBatchSizeInBytes > batch.contentSizeInBytes
		) {
			// Nothing to do if the batch is empty or if compression is disabled or if we don't need to compress
			return batch;
		}

		const compressedBatch = this.params.compressor.compressBatch(batch);
		if (compressedBatch.contentSizeInBytes <= this.params.config.maxBatchSizeInBytes) {
			// If we don't reach the maximum supported size of a batch, it can safely be sent as is
			return compressedBatch;
		}

		if (this.params.splitter.isBatchChunkingEnabled) {
			return this.params.splitter.splitCompressedBatch(compressedBatch);
		}

		// If we've reached this point, the runtime would attempt to send a batch larger than the allowed size
		throw new GenericError("BatchTooLarge", /* error */ undefined, {
			batchSize: batch.contentSizeInBytes,
			compressedBatchSize: compressedBatch.contentSizeInBytes,
			count: compressedBatch.content.length,
			limit: this.params.config.maxBatchSizeInBytes,
			chunkingEnabled: this.params.splitter.isBatchChunkingEnabled,
			compressionOptions: JSON.stringify(this.params.config.compressionOptions),
		});
	}

	/**
	 * Sends the batch object to the container context to be sent over the wire.
	 *
	 * @param batch - batch to be sent
	 */
	private sendBatch(batch: IBatch) {
		const length = batch.content.length;

		// Did we disconnect in the middle of turn-based batch?
		// If so, do nothing, as pending state manager will resubmit it correctly on reconnect.
		if (length === 0 || !this.params.shouldSend()) {
			return;
		}

		if (this.params.containerContext.submitBatchFn === undefined) {
			// Legacy path - supporting old loader versions. Can be removed only when LTS moves above
			// version that has support for batches (submitBatchFn)
			for (const message of batch.content) {
				// Legacy path doesn't support compressed payloads and will submit uncompressed payload anyways
				if (message.metadata?.compressed) {
					delete message.metadata.compressed;
				}

				this.params.containerContext.submitFn(
					MessageType.Operation,
					message.deserializedContent,
					true, // batch
					message.metadata,
				);
			}

			this.params.containerContext.deltaManager.flush();
		} else {
			this.params.containerContext.submitBatchFn(
				batch.content.map((message) => ({
					contents: message.contents,
					metadata: message.metadata,
					compression: message.compression,
				})),
			);
		}
	}

	private persistBatch(batch: BatchMessage[]) {
		// Let the PendingStateManager know that a message was submitted.
		// In future, need to shift toward keeping batch as a whole!
		for (const message of batch) {
			this.params.pendingStateManager.onSubmitMessage(
				message.deserializedContent.type,
				message.referenceSequenceNumber,
				message.deserializedContent.contents,
				message.localOpMetadata,
				message.metadata,
			);
		}
	}

	public checkpoint() {
		return {
			mainBatch: this.mainBatch.checkpoint(),
			attachFlowBatch: this.attachFlowBatch.checkpoint(),
		};
	}
}
