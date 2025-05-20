import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_, DateTimeColumn as DateTimeColumn_, IntColumn as IntColumn_} from "@subsquid/typeorm-store"
import {Owner} from "./owner.model"

@Entity_()
export class Transfer {
    constructor(props?: Partial<Transfer>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    token!: string

    @Index_()
    @ManyToOne_(() => Owner, {nullable: true})
    from!: Owner

    @Index_()
    @ManyToOne_(() => Owner, {nullable: true})
    to!: Owner

    @BigIntColumn_({nullable: false})
    amount!: bigint

    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @IntColumn_({nullable: false})
    slot!: number

    @IntColumn_({nullable: false})
    blockNumber!: number

    @StringColumn_({nullable: false})
    signature!: string
}
