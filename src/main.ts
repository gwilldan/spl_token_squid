import { run } from "@subsquid/batch-processor";
import { augmentBlock } from "@subsquid/solana-objects";
import { DataSourceBuilder, SolanaRpcClient } from "@subsquid/solana-stream";
import { TypeormDatabase } from "@subsquid/typeorm-store";
import * as tokenProgram from "./abi/token-program";
import bs58 from "bs58";
import { Transfer } from "./model/generated";

const mint = "DBRiDgJAMsM95moTzJs7M9LnkGErpbv9v6CUR1DXnUu5";

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
			preAmount: false,
			postAmount: false,
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
	// .addInstruction({
	//   // select instructions, that:
	//   where: {
	//     programId: [tokenProgram.programId], // where executed by token program
	//     d1: [tokenProgram.instructions.transfer.d1],
	//     isCommitted: true, // where successfully isCommitted
	//   },
	//   // for each instruction selected above
	//   // make sure to also include:
	//   include: {
	//     innerInstructions: true, // inner instructions
	//     transaction: true, // transaction, that executed the given instruction
	//     transactionTokenBalances: true, // all token balance records of executed transaction
	//   },
	// })
	.addTokenBalance({
		where: {
			// the token program which the mint belongs - Token2022 (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) or Token (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
			preProgramId: [tokenProgram.programId],
			// postProgramId: [tokenProgram.programId],
			preMint: [mint],
			// postMint: [mint],
		},
		include: {
			transaction: true, // transaction, that executed the given instruction
			transactionInstructions: true, // all instructions of executed transaction
		},
	})
	.build();

// Once we've prepared a data source we can start fetching the data right away:
//
// for await (let batch of dataSource.getBlockStream()) {
//     for (let block of batch) {
//         console.log(block)
//     }
// }
//
// However, Subsquid SDK can also help to decode and persist the data.
//

// Data processing in Subsquid SDK is defined by four components:
//
//  1. Data source (such as we've created above)
//  2. Database
//  3. Data handler
//  4. Processor
//
// Database is responsible for persisting the work progress (last processed block)
// and for providing storage API to the data handler.
//
// Data handler is a user defined function which accepts consecutive block batches,
// storage API and is responsible for entire data transformation.
//
// Processor connects and executes above three components.
//

// Below we create a TypeormDatabase.
//
// It provides restricted subset of [TypeORM EntityManager API](https://typeorm.io/working-with-entity-manager)
// as a persistent storage interface and works with any Postgres-compatible database.
//
// Note, that we don't pass any database connection parameters.
// That's because TypeormDatabase expects a certain project structure
// and environment variables to pick everything it needs by convention.
// Companion @subsquid/typeorm-migration tool works in the same way.
//
// For full configuration details please consult
// https://github.com/subsquid/squid-sdk/blob/278195bd5a5ed0a9e24bfb99ee7bbb86ff94ccb3/typeorm/typeorm-config/src/config.ts#L21
const database = new TypeormDatabase();

// Now we are ready to start data processing
run(dataSource, database, async (ctx) => {
	// Block items that we get from ctx.blocks are flat JS objects.
	//
	// We can use augmentBlock() function from @subsquid/solana-objects
	// to enrich block items with references to related objects and
	// with convenient getters for derived data (e.g. Instruction.d8).
	let blocks = ctx.blocks.map(augmentBlock);

	let transfers: Transfer[] = [];

	for (let block of blocks) {
		for (let ins of block.instructions) {
			// https://read.cryptodatabytes.com/p/starter-guide-to-solana-data-analysis

			if (
				ins.programId !== tokenProgram.programId ||
				ins.d1 !== tokenProgram.instructions.transfer.d1
			) {
				continue;
			}
			const source = ins.accounts[0];
			const destination = ins.accounts[1];

			const tx = ins.getTransaction();

			const srcTransfer = tx.tokenBalances.find((tb) => tb.account == source);

			const tokenMint = srcTransfer?.preMint;

			if (tokenMint !== mint) {
				continue;
			}

			const from = srcTransfer?.preOwner;
			const desTransfer = tx.tokenBalances.find(
				(tb) => tb.account === destination
			);

			const to = desTransfer?.postOwner || desTransfer?.preOwner || destination;

			const amount = decodeSplTransferAmountFromBase58(ins.data);

			transfers.push(
				new Transfer({
					id: ins.id,
					mint: tokenMint,
					from,
					to,
					amount,
					timestamp: new Date(block.header.timestamp * 1000),
					slot: block.header.slot,
					blockNumber: block.header.height,
					txHash: tx.signatures[0],
				})
			);
		}
	}

	await ctx.store.insert(transfers);
});

function decodeSplTransferAmountFromBase58(dataBase58: string): bigint {
	const data = bs58.decode(dataBase58);

	if (data[0] !== 3) {
		throw new Error("Not a SPL Token Transfer instruction");
	}

	if (data.length < 9) {
		throw new Error("Invalid instruction data length");
	}

	const amountBytes = data.slice(1, 9);
	const amount = BigInt(
		amountBytes.reduce((acc, byte, i) => acc + (byte << (8 * i)), 0)
	);

	return amount;
}
