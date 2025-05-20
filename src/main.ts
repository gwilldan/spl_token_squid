import { run } from "@subsquid/batch-processor";
import { augmentBlock } from "@subsquid/solana-objects";
import { TypeormDatabase } from "@subsquid/typeorm-store";
import * as tokenProgram from "./abi/token-program";
import { Transfer, Owner } from "./model/generated";
import { mint } from "./constants";
import { dataSource } from "./datasource";
import bs58 from "bs58";

const database = new TypeormDatabase();

interface RawTransfer {
	id: string;
	token: string;
	from: string;
	fromBal: bigint;
	to: string;
	toBal: bigint;
	amount: bigint;
	timestamp: Date;
	slot: number;
	blockNumber: number;
	signature: string;
}

run(dataSource, database, async (ctx) => {
	let blocks = ctx.blocks.map(augmentBlock);

	let rawTransfers: RawTransfer[] = [];

	for (let block of blocks) {
		for (let ins of block.instructions) {
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

			//create a new Type for raw transfers and pass the token ID (the NFT ID) to the token id
			rawTransfers.push({
				id: ins.id,
				token: ins.id,
				from: from as string,
				to,
				amount,
				timestamp: new Date(block.header.timestamp * 1000),
				slot: block.header.slot,
				blockNumber: block.header.height,
				fromBal: srcTransfer?.postAmount || 0n,
				toBal: srcTransfer?.postAmount || 0n,
				signature: tx.signatures[0],
			});
		}
	}

	const owners: Map<string, Owner> = createOwners(rawTransfers);

	const transfers: Transfer[] = createTransfers(rawTransfers, owners);

	await Promise.all([
		ctx.store.upsert([...owners.values()]),
		ctx.store.insert(transfers),
	]);
});

function createOwners(rawTransfers: RawTransfer[]): Map<string, Owner> {
	let owners: Map<string, Owner> = new Map();
	for (const t of rawTransfers) {
		owners.set(t.from, new Owner({ id: t.from, balance: t.fromBal }));
		owners.set(t.to, new Owner({ id: t.to, balance: t.toBal }));
	}
	return owners;
}

function createTransfers(
	rawTransfers: RawTransfer[],
	owners: Map<string, Owner>
): Transfer[] {
	return rawTransfers.map(
		(t) =>
			new Transfer({
				id: t.id,
				token: t.token,
				from: owners.get(t.from),
				to: owners.get(t.to),
				amount: t.amount,
				timestamp: t.timestamp,
				slot: t.slot,
				blockNumber: t.blockNumber,
				signature: t.signature,
			})
	);
}

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
