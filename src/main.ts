import { run } from "@subsquid/batch-processor";
import { augmentBlock } from "@subsquid/solana-objects";
import { DataSourceBuilder, SolanaRpcClient } from "@subsquid/solana-stream";
import { TypeormDatabase } from "@subsquid/typeorm-store";
import assert from "assert";
import * as tokenProgram from "./abi/token-program";
import bs58 from "bs58";
import { Transfer } from "./model/generated";

const mint = "Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs";

// First we create a DataSource - component,
// that defines where to get the data and what data should we get.
const dataSource = new DataSourceBuilder()
	// Provide Subsquid Network Gateway URL.
	.setGateway("https://v2.archive.subsquid.io/network/solana-mainnet")
	// Subsquid Network is always about 1000 blocks behind the head.
	// We must use regular RPC endpoint to get through the last mile
	// and stay on top of the chain.
	// This is a limitation, and we promise to lift it in the future!
	.setRpc(
		process.env.SOLANA_NODE == null
			? undefined
			: {
					client: new SolanaRpcClient({
						url: process.env.SOLANA_NODE,
						// rateLimit: 100 // requests per sec
					}),
					strideConcurrency: 10,
			  }
	)
	// Currently only blocks from 260000000 and above are stored in Subsquid Network.
	// When we specify it, we must also limit the range of requested blocks.
	//
	// Same applies to RPC endpoint of a node that cleanups its history.
	//
	// NOTE, that block ranges are specified in heights, not in slots !!!
	//
	.setBlockRange({ from: 289819150 })
	//
	// Block data returned by the data source has the following structure:
	//
	// interface Block {
	//     header: BlockHeader
	//     transactions: Transaction[]
	//     instructions: Instruction[]
	//     logs: LogMessage[]
	//     balances: Balance[]
	//     tokenBalances: TokenBalance[]
	//     rewards: Reward[]
	// }
	//
	// For each block item we can specify a set of fields we want to fetch via .setFields() method.
	// Think about it as of SQL projection.
	//
	// Accurate selection of only required fields can have a notable positive impact
	// on performance when data is sourced from Subsquid Network.
	//
	// We do it below only for illustration as all fields we've selected
	// are fetched by default.
	//
	// It is possible to override default selection by setting undesired fields to false.
	.setFields({
		block: {
			// block header fields
			timestamp: true,
		},
		transaction: {
			// transaction fields
			signatures: true,
		},
		instruction: {
			// instruction fields
			programId: true,
			accounts: true,
			data: true,
		},
		tokenBalance: {
			// token balance record fields
			preAmount: true,
			postAmount: true,
			preOwner: true,
			postOwner: true,
		},
	})
	// By default, block can be skipped if it doesn't contain explicitly requested items.
	//
	// We request items via .addXxx() methods.
	//
	// Each .addXxx() method accepts item selection criteria
	// and also allows to request related items.
	//
	.addInstruction({
		// select instructions, that:
		where: {
			programId: [tokenProgram.programId], // where executed by token program
			d1: [tokenProgram.instructions.transfer.d1],
			isCommitted: true, // where successfully committed
		},
		// for each instruction selected above
		// make sure to also include:
		include: {
			innerInstructions: true, // inner instructions
			transaction: true, // transaction, that executed the given instruction
			transactionTokenBalances: true, // all token balance records of executed transaction
		},
	})
	.addTokenBalance({
		where: {
			// the token program which the mint belongs - Token2022 (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) or Token (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
			preProgramId: [tokenProgram.programId],
			preMint: [mint],
			postMint: [mint],
		},
		include: {
			transaction: true, // transaction, that executed the given instruction
			transactionInstructions: true, // all instructions of executed transaction
		},
	})
	.build();

// Constants for frequently used conditions
const TRANSFER_INSTRUCTION_D1 = tokenProgram.instructions.transfer.d1;
const BATCH_SIZE = 500;

const database = new TypeormDatabase();

// Now we are ready to start data processing
run(
	dataSource,
	database,
	async (ctx: {
		blocks: any[];
		store: { insert: (data: Transfer[]) => Promise<void> };
	}) => {
		let blocks = ctx.blocks.map(augmentBlock);
		let transfers: Transfer[] = [];

		for (let block of blocks) {
			for (let ins of block.instructions) {
				// Fast-path rejection for non-matching instructions
				if (
					ins.programId !== tokenProgram.programId ||
					ins.d1 !== TRANSFER_INSTRUCTION_D1
				) {
					continue;
				}

				const source = ins.accounts[0];
				const destination = ins.accounts[1];

				// Get transaction once and reuse
				const transaction = ins.getTransaction();
				const tokenBalances = transaction.tokenBalances;

				// Use find with direct comparison for better performance
				const srcTransfer = tokenBalances.find((tb) => tb.account === source);
				if (!srcTransfer || srcTransfer.preMint !== mint) {
					continue;
				}

				const from = srcTransfer.preOwner;
				const desTransfer = tokenBalances.find(
					(tb) => tb.account === destination
				);
				const to =
					desTransfer?.postOwner || desTransfer?.preOwner || destination;

				const amount = decodeSplTransferAmountFromBase58(ins.data);

				transfers.push(
					new Transfer({
						id: ins.id,
						mint: srcTransfer.preMint,
						from,
						to,
						amount,
						timestamp: new Date(block.header.timestamp * 1000),
						slot: block.header.slot,
						blockNumber: block.header.height,
						txHash: transaction.signatures[0],
					})
				);

				// Batch insert when we reach the batch size
				if (transfers.length >= BATCH_SIZE) {
					await ctx.store.insert(transfers);
					transfers = [];
				}
			}
		}

		// Insert any remaining transfers
		if (transfers.length > 0) {
			await ctx.store.insert(transfers);
		}
	}
);

// Optimized amount decoding function using TypedArray for better performance
function decodeSplTransferAmountFromBase58(dataBase58: string): bigint {
	const data = bs58.decode(dataBase58);

	if (data[0] !== 3 || data.length < 9) {
		throw new Error("Invalid SPL Token Transfer instruction");
	}

	// Use DataView for more efficient binary data handling
	const view = new DataView(data.buffer, data.byteOffset + 1, 8);
	return BigInt(view.getBigUint64(0, true)); // true for little-endian
}
