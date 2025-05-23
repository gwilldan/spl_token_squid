import {struct, u64} from '@subsquid/borsh'
import {instruction} from './abi.support'


export const instructions = {
		transfer: instruction(
  		  {
        		d1: '0x03',
    		},
    		{
        		source: 0,
        		destination: 1,
        		signer: 2,
    		},
    		struct({
        		amount: u64
    		})
		)
}

export const programId = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"