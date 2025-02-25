import { modelOptions, prop } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'

export interface Message extends Base {}
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Message {
	@prop({ unique: true })
	paymentMessage: string

	@prop({ unique: true })
	receivedMessage: string
}
