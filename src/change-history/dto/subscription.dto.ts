export class SubscriptionDto {
	endpoint: string
	keys: {
		p256dh: string
		auth: string
	}
}
