// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const path = require('path')
const { promisify } = require('util')
const fs = require('fs')
const objectHash = require("ocore/object_hash.js");
const parseOjson = require('ocore/formula/parse_ojson').parse

async function getAaAddress(aa_src) {
	return objectHash.getChash160(await promisify(parseOjson)(aa_src));
}

function wait(ms) {
	return new Promise(r => setTimeout(r, ms))
}


describe('COOP', function () {
	this.timeout(240000)

	before(async () => {

		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.agent({ governance_base: path.join(__dirname, '../governance.oscript') })
			.with.wallet({ alice: 1000e9 })
			.with.wallet({ bob: 1000e9 })
			.with.wallet({ carol: 1000e9 })
			.with.wallet({ messagingAttestor: 1e9 })
			.with.wallet({ realNameAttestor: 1e9 })
		//	.with.explorer()
			.run()
		
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()

		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		
		this.carol = this.network.wallet.carol
		this.carolAddress = await this.carol.getAddress()
		
		this.messagingAttestor = this.network.wallet.messagingAttestor
		this.messagingAttestorAddress = await this.messagingAttestor.getAddress()
		
		this.realNameAttestor = this.network.wallet.realNameAttestor
		this.realNameAttestorAddress = await this.realNameAttestor.getAddress()

		this.variables = {
			daily_locked_reward: 0.01,
			daily_liquid_reward: 0.001,
			bytes_reducer: 0.75,
			by_votes_share: 0.5,
			messaging_attestors: this.messagingAttestorAddress,
			real_name_attestors: this.realNameAttestorAddress,
			referrer_coop_deposit_reward_share: 0.02,
			referrer_bytes_deposit_reward_share: 0.01,
			referral_reward: 10e9,
			min_balance_instead_of_real_name: 50e9,
		}


		this.timetravel = async (shift = '1d') => {
			const { error, timestamp } = await this.network.timetravel({ shift })
			expect(error).to.be.null
			return Math.round(timestamp / 1000)
		}

		this.timetravelToDate = async (to) => {
			const { error, timestamp } = await this.network.timetravel({ to })
			expect(error).to.be.null
		}

		this.executeGetter = async (aa, getter, args = []) => {
			const { result, error } = await this.alice.executeGetter({
				aaAddress: aa,
				getter,
				args
			})
			if (error)
				console.log(error)
			expect(error).to.be.null
			return result
		}

		this.update_emissions = (timestamp) => {
			if (!timestamp) throw Error(`no timestamp`)
			const ceiling_price = 2 ** ((timestamp - this.launch_ts) / (365 * 24 * 3600))
			const elapsed_days = (timestamp - this.state.ts) / 24 / 3600
			const s = this.state.total_locked + this.state.total_locked_bytes / ceiling_price * this.variables.bytes_reducer;
			const new_locked_emissions = s * this.variables.daily_locked_reward * elapsed_days;
			const new_liquid_emissions = s * this.variables.daily_liquid_reward * elapsed_days;
			this.state.locked_emissions += new_locked_emissions;
			this.state.liquid_emissions += new_liquid_emissions;
			if (this.state.total_votes > 0 && this.state.total_votes_bal > 0) {
				this.state.locked_emissions_per_vote += new_locked_emissions / this.state.total_votes;
				this.state.liquid_emissions_per_vote += new_liquid_emissions / this.state.total_votes;
				this.state.locked_emissions_per_vb += new_locked_emissions / this.state.total_votes_bal;
				this.state.liquid_emissions_per_vb += new_liquid_emissions / this.state.total_votes_bal;
			}
			this.state.ts = timestamp;
		}

		this.update_user = (user, timestamp) => {
			if (!timestamp) throw Error(`no timestamp`)
			const ceiling_price = 2 ** ((timestamp - this.launch_ts) / (365 * 24 * 3600))
			const old_total_balance = user.total_balance;
			const new_locked_emissions_per_vote = this.state.locked_emissions_per_vote - user.last_locked_emissions_per_vote;
			const new_liquid_emissions_per_vote = this.state.liquid_emissions_per_vote - user.last_liquid_emissions_per_vote;
			const new_locked_emissions_per_vb = this.state.locked_emissions_per_vb - user.last_locked_emissions_per_vb;
			const new_liquid_emissions_per_vb = this.state.liquid_emissions_per_vb - user.last_liquid_emissions_per_vb;
			user.last_locked_emissions_per_vote = this.state.locked_emissions_per_vote;
			user.last_liquid_emissions_per_vote = this.state.liquid_emissions_per_vote;
			user.last_locked_emissions_per_vb = this.state.locked_emissions_per_vb;
			user.last_liquid_emissions_per_vb = this.state.liquid_emissions_per_vb;
			const votes = user.votes || 0;
			const user_new_locked_emissions = this.variables.by_votes_share * votes * new_locked_emissions_per_vote + (1 - this.variables.by_votes_share) * votes * old_total_balance * new_locked_emissions_per_vb;
			const user_new_liquid_emissions = this.variables.by_votes_share * votes * new_liquid_emissions_per_vote + (1 - this.variables.by_votes_share) * votes * old_total_balance * new_liquid_emissions_per_vb;
			user.balance += user_new_locked_emissions;
			if (!user.liquid_balance) user.liquid_balance = 0;
			user.liquid_balance += user_new_liquid_emissions;
			if (!user.locked_rewards) user.locked_rewards = 0;
			if (!user.liquid_rewards) user.liquid_rewards = 0;
			user.locked_rewards += user_new_locked_emissions;
			user.liquid_rewards += user_new_liquid_emissions;

			// increases thanks to emissions, decreases thanks to depreciation of bytes balance
			user.total_balance = user.balance + user.bytes_balance/ceiling_price * this.variables.bytes_reducer; 
			user.last_ts = timestamp;

			this.state.total_locked += user_new_locked_emissions;
			this.state.total_votes_bal += (user.total_balance - old_total_balance) * votes;
		};

		this.check_totals = () => {
			let users = [this.alice_profile]
			if (this.bob_profile) users.push(this.bob_profile)
			if (this.carol_profile) users.push(this.carol_profile)
			let total_locked = 0
			let total_locked_bytes = 0
			let total_votes = 0
			let total_votes_bal = 0
			for (let user of users) {
				total_locked += user.balance
				total_locked_bytes += user.bytes_balance
				total_votes += user.votes || 0
				total_votes_bal += (user.votes || 0) * user.total_balance
			}
			expect(this.state.total_locked).to.deepCloseTo(total_locked, 14)
			expect(this.state.total_locked_bytes).to.eq(total_locked_bytes)
			expect(this.state.total_votes).to.deepCloseTo(total_votes, 14)
			expect(this.state.total_votes_bal).to.deepCloseTo(total_votes_bal, 14)
		}


	})


	it('Deploy COOP AA', async () => {
		let coop = fs.readFileSync(path.join(__dirname, '../coop.oscript'), 'utf8');
		coop = coop.replace(/messaging_attestors: '[\w:]*'/, `messaging_attestors: '${this.messagingAttestorAddress}'`)
		coop = coop.replace(/real_name_attestors: '[\w:]*'/, `real_name_attestors: '${this.realNameAttestorAddress}'`)

		const { address, error } = await this.alice.deployAgent(coop)
		console.log(error)
		expect(error).to.be.null
		this.coop_aa = address
	})


	it('Alice defines the token', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10000,
			data: {
				define: 1
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		this.asset = response.response.responseVars.asset

		const { vars } = await this.alice.readAAStateVars(this.coop_aa)
		this.governance_aa = vars.constants.governance_aa
		this.launch_ts = vars.constants.launch_ts
		expect(this.governance_aa).to.be.validAddress
		expect(this.launch_ts).to.be.eq(response.timestamp)
	})


	it('Alice tries to deposit while not being messaging-attested', async () => {
		const amount = 1e9
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: amount,
			data: {
				deposit: 1
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
		expect(response.response.error).to.eq("your address must be attested on a messaging service")
	})

	
	it('Attest alice for messaging', async () => {
		const { unit, error } = await this.messagingAttestor.sendMulti({
			messages: [{
				app: 'attestation',
				payload: {
					address: this.aliceAddress,
					profile: {
						username: 'alice',
						userId: '123',
					},
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Alice tries to deposit while not being real-name attested', async () => {
		const amount = 1e9
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: amount,
			data: {
				deposit: 1
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
		expect(response.response.error).to.eq(`your address must be real-name attested or you should deposit at least ${this.variables.min_balance_instead_of_real_name / 1e9} COOP`)
	})


	it('Attest the real name of alice', async () => {
		const { unit, error } = await this.realNameAttestor.sendMulti({
			messages: [{
				app: 'attestation',
				payload: {
					address: this.aliceAddress,
					profile: {
						user_id: 'aaaa',
					},
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Alice tries to deposit while indicating herself as referrer', async () => {
		const amount = 1e9
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: amount,
			data: {
				deposit: 1,
				ref: this.aliceAddress,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
		expect(response.response.error).to.eq("referrer doesn't exist")
	})


	it('Alice deposits', async () => {
		const amount = 10e9
		console.log(`paying ${amount/1e9} GB`)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: amount + 10_000,
			data: {
				deposit: 1
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Deposited")
		const unlock_date = new Date((response.timestamp + 365 * 24 * 3600) * 1000).toISOString().substring(0, 10)
		const today = new Date(response.timestamp * 1000).toISOString().substring(0, 10)
		expect(response.response.responseVars.unlock_date).to.eq(unlock_date)

		this.total_locked_bytes = amount
		this.alice_profile = {
			balance: 0,
			bytes_balance: amount,
			total_balance: amount * this.variables.bytes_reducer,
			unlock_date,
			reg_date: today,
			reg_ts: response.timestamp,
			last_ts: response.timestamp,
			last_locked_emissions_per_vote: 0,
			last_liquid_emissions_per_vote: 0,
			last_locked_emissions_per_vb: 0,
			last_liquid_emissions_per_vb: 0,
			liquid_balance: 0,
			liquid_rewards: 0,
			locked_rewards: 0,
		}

		this.state = {
			total_locked: 0,
			total_locked_bytes: amount,
			total_votes: 0,
			total_votes_bal: 0,
			locked_emissions: 0,
			liquid_emissions: 0,
			locked_emissions_per_vote: 0,
			liquid_emissions_per_vote: 0,
			locked_emissions_per_vb: 0,
			liquid_emissions_per_vb: 0,
			ts: response.timestamp,
		}

		const { vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(vars['user_' + this.aliceAddress]).to.deep.eq(this.alice_profile)
		expect(vars['rn_address_aaaa']).to.eq(this.aliceAddress)
		expect(vars.state).to.deep.eq(this.state)
	})


	it('Attest bob for messaging', async () => {
		const { unit, error } = await this.messagingAttestor.sendMulti({
			messages: [{
				app: 'attestation',
				payload: {
					address: this.bobAddress,
					profile: {
						username: 'bob',
						userId: '456',
					},
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Bob deposits 50.1 GB without real-name attestation', async () => {
		const amount = 50.1e9
		console.log(`paying ${amount/1e9} GB`)

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: amount + 10_000,
			data: {
				deposit: 1
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Deposited")
		const unlock_date = new Date((response.timestamp + 365 * 24 * 3600) * 1000).toISOString().substring(0, 10)
		const today = new Date(response.timestamp * 1000).toISOString().substring(0, 10)
		expect(response.response.responseVars.unlock_date).to.eq(unlock_date)

		this.total_locked_bytes += amount
		this.bob_profile = {
			balance: 0,
			bytes_balance: amount,
			total_balance: amount * this.variables.bytes_reducer,
			unlock_date,
			reg_date: today,
			reg_ts: response.timestamp,
			last_ts: response.timestamp,
			last_locked_emissions_per_vote: 0,
			last_liquid_emissions_per_vote: 0,
			last_locked_emissions_per_vb: 0,
			last_liquid_emissions_per_vb: 0,
			liquid_balance: 0,
			liquid_rewards: 0,
			locked_rewards: 0,
		}

		this.state.total_locked_bytes += amount

		const { vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(vars['user_' + this.bobAddress]).to.deep.eq(this.bob_profile)
		expect(vars.state).to.deep.eq(this.state)
	})




	it('Alice extends the term', async () => {
		const term = 500

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10_000,
			data: {
				deposit: 1,
				term,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.undefined
		const unlock_date = new Date((response.timestamp + term * 24 * 3600) * 1000).toISOString().substring(0, 10)
		expect(response.response.responseVars.unlock_date).to.eq(unlock_date)

		this.alice_profile.unlock_date = unlock_date

		const { vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(vars['user_' + this.aliceAddress]).to.deep.eq(this.alice_profile)
		expect(vars.state).to.deep.eq(this.state)
	})


	it('Bob extends the term', async () => {
		const term = 500

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10_000,
			data: {
				deposit: 1,
				term,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.undefined
		const unlock_date = new Date((response.timestamp + term * 24 * 3600) * 1000).toISOString().substring(0, 10)
		expect(response.response.responseVars.unlock_date).to.eq(unlock_date)

		this.bob_profile.unlock_date = unlock_date

		const { vars } = await this.bob.readAAStateVars(this.coop_aa)
		expect(vars['user_' + this.bobAddress]).to.deep.eq(this.bob_profile)
		expect(vars.state).to.deep.eq(this.state)
	})


	it('Alice votes for Bob', async () => {
		const strength = 2.5

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10_000,
			data: {
				vote: 1,
				for: this.bobAddress,
				strength,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq('Voted')

		const bob_votes = strength * Math.sqrt(this.alice_profile.total_balance)
		const alice_votes = 3 * Math.sqrt(this.alice_profile.total_balance)
		this.bob_profile.votes = bob_votes
		this.alice_profile.votes = alice_votes
		this.state.total_votes = alice_votes + bob_votes
		this.state.total_votes_bal = alice_votes * this.alice_profile.total_balance + bob_votes * this.bob_profile.total_balance

		const { vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(vars['vote_' + this.aliceAddress + '_' + this.bobAddress]).to.deepCloseTo({ votes: bob_votes, strength: strength, ts: response.timestamp }, 14)
		expect(vars['vote_' + this.aliceAddress + '_' + this.aliceAddress]).to.deepCloseTo({ votes: alice_votes, strength: 3, ts: response.timestamp }, 14)
		expect(vars['user_' + this.aliceAddress]).to.deepCloseTo(this.alice_profile, 14)
		expect(vars['user_' + this.bobAddress]).to.deepCloseTo(this.bob_profile, 14)
		expect(vars.state).to.deepCloseTo(this.state, 14)
		this.check_totals()
	})


	it('Alice votes for Bob again after 1 day', async () => {
		const timestamp = await this.timetravel('1d')
		this.update_emissions(timestamp)
		this.update_user(this.alice_profile, timestamp)
		this.update_user(this.bob_profile, timestamp)
		expect(this.alice_profile.liquid_balance).to.be.gt(0)
		expect(this.bob_profile.liquid_balance).to.be.gt(0)
		this.check_totals()

		const strength = 1.5

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10_000,
			data: {
				vote: 1,
				for: this.bobAddress,
				strength,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq('Voted')

		const bob_votes = strength * Math.sqrt(this.alice_profile.total_balance)
		const alice_votes = 3 * Math.sqrt(this.alice_profile.total_balance)
		const delta_bob_votes = bob_votes - this.bob_profile.votes
		const delta_alice_votes = alice_votes - this.alice_profile.votes
		expect(delta_bob_votes).to.be.lt(0) // thanks to smaller strength
		expect(delta_alice_votes).to.be.gt(0) // thanks to emissions
		this.bob_profile.votes = bob_votes
		this.alice_profile.votes = alice_votes
		this.state.total_votes += delta_bob_votes + delta_alice_votes
		this.state.total_votes_bal = alice_votes * this.alice_profile.total_balance + bob_votes * this.bob_profile.total_balance

		const { vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(vars['vote_' + this.aliceAddress + '_' + this.bobAddress]).to.deepCloseTo({ votes: bob_votes, strength: strength, ts: response.timestamp }, 14)
		expect(vars['vote_' + this.aliceAddress + '_' + this.aliceAddress]).to.deepCloseTo({ votes: alice_votes, strength: 3, ts: response.timestamp }, 14)
		expect(vars['user_' + this.aliceAddress]).to.deepCloseTo(this.alice_profile, 14)
		expect(vars['user_' + this.bobAddress]).to.deepCloseTo(this.bob_profile, 14)
		expect(vars.state).to.deepCloseTo(this.state, 13)
		this.check_totals()

		this.alice_to_bob_votes = bob_votes
	})


	it('Bob claims after 10 days', async () => {
		const timestamp = await this.timetravel('10d')
		this.update_emissions(timestamp)
		this.update_user(this.bob_profile, timestamp)
		expect(this.bob_profile.liquid_balance).to.be.gt(0)
		this.check_totals()

		const restake_percent = 10
		const claimed_amount = Math.floor(this.bob_profile.liquid_balance * (1 - restake_percent/100))
		const restaked_amount = this.bob_profile.liquid_balance * restake_percent/100

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10_000,
			data: {
				claim: 1,
				restake_percent,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.eq('Claimed')

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: claimed_amount,
			},
		])
		
		this.bob_liquid = claimed_amount
		this.bob_profile.liquid_balance = 0
		this.bob_profile.balance += restaked_amount
		this.bob_profile.total_balance += restaked_amount
		this.state.total_locked += restaked_amount
		this.state.total_votes_bal += restaked_amount * this.bob_profile.votes

		const { vars } = await this.bob.readAAStateVars(this.coop_aa)
		expect(vars['user_' + this.aliceAddress]).to.deepCloseTo(this.alice_profile, 14)
		expect(vars['user_' + this.bobAddress]).to.deepCloseTo(this.bob_profile, 14)
		expect(vars.state).to.deepCloseTo(this.state, 13)
		this.check_totals()
	})



	it("Alice votes for changing the messaging attestors", async () => {
		const timestamp = await this.timetravel('0d')
		const sqrt_balance = Math.sqrt(this.alice_profile.total_balance)

		const name = 'messaging_attestors'
		const value = this.messagingAttestorAddress + ':' + this.bobAddress
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				value,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: coop_vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(coop_vars['variables']).to.be.undefined

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars['support_' + name + '_' + value]).to.deepCloseTo(sqrt_balance, 14)
		expect(vars['leader_' + name]).to.eq(value)
		expect(vars['challenging_period_start_ts_' + name]).to.eq(response.timestamp)
		expect(vars['choice_' + this.aliceAddress + '_' + name]).to.eq(value)
		expect(vars['votes_' + this.aliceAddress]).deepCloseTo({
			messaging_attestors: {
				value,
				sqrt_balance,
			},
		}, 14)

	})


	it("Alice commits the new messaging attestors", async () => {
		await this.timetravel('4d')
		const name = 'messaging_attestors'
		const value = this.messagingAttestorAddress + ':' + this.bobAddress
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				commit: 1,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars[name]).to.eq(value)

		this.variables.messaging_attestors = value
		const { vars: coop_vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(coop_vars.variables).to.deep.eq(this.variables)

	})


	it('Bob sends some COOP to Carol', async () => {
		const amount = Math.floor(this.bob_liquid / 2)
		const { unit, error } = await this.bob.sendMulti({
			to_address: this.carolAddress,
			amount,
			asset: this.asset,
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.carol_liquid = amount
		this.bob_liquid -= amount
	})


	it('Attest carol for messaging, Bob is the attestor', async () => {
		const { unit, error } = await this.bob.sendMulti({
			messages: [{
				app: 'attestation',
				payload: {
					address: this.carolAddress,
					profile: {
						username: 'carol',
					},
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Attest the real name of carol', async () => {
		const { unit, error } = await this.realNameAttestor.sendMulti({
			messages: [{
				app: 'attestation',
				payload: {
					address: this.carolAddress,
					profile: {
						user_id: 'cccccc',
					},
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Carol deposits with Bob as referrer', async () => {
		const timestamp = await this.timetravel('0d')
		this.update_emissions(timestamp)
		this.check_totals()
		const term = 500
		const amount = this.carol_liquid
		const capped_referral_reward = Math.min(amount, 10e9)
		console.log(`paying ${amount/1e9} COOP`)

		const { unit, error } = await this.carol.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.coop_aa, amount: amount }],
				base: [{ address: this.coop_aa, amount: 10_000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					deposit: 1,
					term,
					ref: this.bobAddress,
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.carol, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.eq("Deposited")
		const unlock_date = new Date((response.timestamp + term * 24 * 3600) * 1000).toISOString().substring(0, 10)
		const today = new Date(response.timestamp * 1000).toISOString().substring(0, 10)
		expect(response.response.responseVars.unlock_date).to.eq(unlock_date)

		this.total_locked += amount + 2 * capped_referral_reward
		this.carol_profile = {
			balance: amount + capped_referral_reward,
			bytes_balance: 0,
			liquid_balance: 0,
			total_balance: amount + capped_referral_reward,
			locked_rewards: 0,
			liquid_rewards: 0,
			unlock_date,
			reg_date: today,
			reg_ts: response.timestamp,
			last_ts: response.timestamp,
			ref: this.bobAddress,
			last_locked_emissions_per_vote: this.state.locked_emissions_per_vote,
			last_liquid_emissions_per_vote: this.state.liquid_emissions_per_vote,
			last_locked_emissions_per_vb: this.state.locked_emissions_per_vb,
			last_liquid_emissions_per_vb: this.state.liquid_emissions_per_vb,
		}
		this.bob_profile.referred_users = 1
		this.bob_profile.referral_rewards = capped_referral_reward
		this.bob_profile.balance += capped_referral_reward
		this.bob_profile.total_balance += capped_referral_reward
		this.state.total_referral_rewards = 2 * capped_referral_reward
		this.state.total_locked += amount + 2 * capped_referral_reward
		this.state.total_votes_bal += capped_referral_reward * this.bob_profile.votes
		this.ts = response.timestamp

		const { vars } = await this.carol.readAAStateVars(this.coop_aa)
		expect(vars['user_' + this.carolAddress]).to.deepCloseTo(this.carol_profile, 14)
		expect(vars['user_' + this.bobAddress]).to.deepCloseTo(this.bob_profile, 14)
		expect(vars.state).to.deepCloseTo(this.state, 13)
		this.check_totals()

		const ref_deposit_reward = Math.floor(amount * this.variables.referrer_coop_deposit_reward_share)
		this.bob_liquid += ref_deposit_reward

		const { unitObj } = await this.carol.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: ref_deposit_reward,
			},
		])

	})


	it('Carol votes for Alice after 30 days', async () => {
		const timestamp = await this.timetravel('30d')
		this.update_emissions(timestamp)
		this.update_user(this.carol_profile, timestamp)
		this.update_user(this.alice_profile, timestamp)
		expect(this.alice_profile.liquid_balance).to.be.gt(0)
		expect(this.carol_profile.liquid_balance).to.be.eq(0)
		this.check_totals()

		const strength = 3

		const { unit, error } = await this.carol.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10_000,
			data: {
				vote: 1,
				for: this.aliceAddress,
				strength,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.carol, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq('Voted')

		const alice_votes = strength * Math.sqrt(this.carol_profile.total_balance)
		const carol_votes = 3 * Math.sqrt(this.carol_profile.total_balance)
		this.alice_profile.votes += alice_votes
		this.carol_profile.votes = carol_votes
		this.state.total_votes += alice_votes + carol_votes
		this.state.total_votes_bal += carol_votes * this.carol_profile.total_balance + alice_votes * this.alice_profile.total_balance

		const { vars } = await this.carol.readAAStateVars(this.coop_aa)
		expect(vars['vote_' + this.carolAddress + '_' + this.carolAddress]).to.deepCloseTo({ votes: carol_votes, strength: 3, ts: response.timestamp }, 14)
		expect(vars['vote_' + this.carolAddress + '_' + this.aliceAddress]).to.deepCloseTo({ votes: alice_votes, strength: strength, ts: response.timestamp }, 14)
		expect(vars['user_' + this.aliceAddress]).to.deepCloseTo(this.alice_profile, 14)
		expect(vars['user_' + this.carolAddress]).to.deepCloseTo(this.carol_profile, 14)
		expect(vars.state).to.deepCloseTo(this.state, 13)
		this.check_totals()
	})


	it('Bob votes for Carol after 60 days and deletes the expired alice-to-bob vote', async () => {
		const timestamp = await this.timetravel('60d')
		this.update_emissions(timestamp)

		// delete the old alice-to-bob vote
		this.bob_profile.votes -= this.alice_to_bob_votes
		this.state.total_votes -= this.alice_to_bob_votes
		this.state.total_votes_bal -= this.alice_to_bob_votes * this.bob_profile.total_balance

		this.update_user(this.bob_profile, timestamp)
		this.update_user(this.carol_profile, timestamp)
		expect(this.carol_profile.liquid_balance).to.be.gt(0)
		expect(this.bob_profile.liquid_balance).to.be.eq(0)
		this.check_totals()

		const strength = 1.5

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10_000,
			data: {
				vote: 1,
				for: this.carolAddress,
				strength,
				delete_expired_votes: {
					[this.aliceAddress]: this.bobAddress,
				},
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq('Voted')

		const carol_votes = strength * Math.sqrt(this.bob_profile.total_balance)
		const bob_votes = 3 * Math.sqrt(this.bob_profile.total_balance)
		this.bob_profile.votes += bob_votes
		this.carol_profile.votes += carol_votes
		this.state.total_votes += bob_votes + carol_votes
		this.state.total_votes_bal += carol_votes * this.carol_profile.total_balance + bob_votes * this.bob_profile.total_balance

		const { vars } = await this.bob.readAAStateVars(this.coop_aa)
		expect(vars['vote_' + this.aliceAddress + '_' + this.bobAddress]).to.be.undefined
		expect(vars['vote_' + this.bobAddress + '_' + this.bobAddress]).to.deepCloseTo({ votes: bob_votes, strength: 3, ts: response.timestamp }, 14)
		expect(vars['vote_' + this.bobAddress + '_' + this.carolAddress]).to.deepCloseTo({ votes: carol_votes, strength: strength, ts: response.timestamp }, 14)
		expect(vars['user_' + this.carolAddress]).to.deepCloseTo(this.carol_profile, 14)
		expect(vars['user_' + this.bobAddress]).to.deepCloseTo(this.bob_profile, 14)
		expect(vars.state).to.deepCloseTo(this.state, 13)
		this.check_totals()
	})


	it("Carol votes for changing the by-votes share", async () => {
		const timestamp = await this.timetravel('0d')
		const ceiling_price = 2 ** ((timestamp - this.launch_ts) / 365 / 24 / 3600)
		const balance = this.carol_profile.bytes_balance / ceiling_price * this.variables.bytes_reducer + this.carol_profile.balance
		const sqrt_balance = Math.sqrt(balance)

		const name = 'by_votes_share'
		const value = 0.3
		const { unit, error } = await this.carol.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				value,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.carol, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: coop_vars } = await this.carol.readAAStateVars(this.coop_aa)
		expect(coop_vars['variables']).to.deep.eq(this.variables)

		this.carolVotes = {
			by_votes_share: {
				value,
				sqrt_balance,
			},
		}
		const { vars } = await this.carol.readAAStateVars(this.governance_aa)
		expect(vars['support_' + name + '_' + value]).to.deepCloseTo(sqrt_balance, 14)
		expect(vars['leader_' + name]).to.eq(value)
		expect(vars['challenging_period_start_ts_' + name]).to.eq(response.timestamp)
		expect(vars['choice_' + this.carolAddress + '_' + name]).to.eq(value)
		expect(vars['votes_' + this.carolAddress]).deepCloseTo(this.carolVotes, 14)

	})


	it("Alice commits the new by-votes share", async () => {
		await this.timetravel('4d')
		const name = 'by_votes_share'
		const value = 0.3
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				commit: 1,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars[name]).to.eq(value)

		this.variables.by_votes_share = value
		const { vars: coop_vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(coop_vars.variables).to.deep.eq(this.variables)

	})


	it('Alice claims', async () => {
		const timestamp = await this.timetravel('0d')
		this.update_emissions(timestamp)
		this.update_user(this.alice_profile, timestamp)
		expect(this.alice_profile.liquid_balance).to.be.gt(0)
		this.check_totals()

		const restake_percent = 15
		const claimed_amount = Math.floor(this.alice_profile.liquid_balance * (1 - restake_percent/100))
		const restaked_amount = this.alice_profile.liquid_balance * restake_percent/100

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10_000,
			data: {
				claim: 1,
				restake_percent,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.eq('Claimed')

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: claimed_amount,
			},
		])
		
		this.alice_liquid = claimed_amount
		this.alice_profile.liquid_balance = 0
		this.alice_profile.balance += restaked_amount
		this.alice_profile.total_balance += restaked_amount
		this.state.total_locked += restaked_amount
		this.state.total_votes_bal += restaked_amount * this.alice_profile.votes

		const { vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(vars['user_' + this.aliceAddress]).to.deepCloseTo(this.alice_profile, 14)
		expect(vars.state).to.deepCloseTo(this.state, 13)
		this.check_totals()
	})


	it('Alice replaces some Bytes with COOP', async () => {
		const timestamp = await this.timetravel('10d')
		this.update_emissions(timestamp)
		this.update_user(this.alice_profile, timestamp)
		this.check_totals()

		const ceiling_price = 2 ** ((timestamp - this.launch_ts) / 365 / 24 / 3600)
		const amount = 1e6
		const out_bytes_amount = Math.floor(amount * ceiling_price)

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.coop_aa, amount: amount }],
				base: [{ address: this.coop_aa, amount: 10_000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					replace: 1,
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.alice_profile.balance += amount
		this.alice_profile.bytes_balance -= out_bytes_amount
		const new_total_balance = this.alice_profile.balance + this.alice_profile.bytes_balance / ceiling_price * this.variables.bytes_reducer
		const delta_total_balance = new_total_balance - this.alice_profile.total_balance
		this.alice_profile.total_balance = new_total_balance
		this.state.total_locked += amount
		this.state.total_locked_bytes -= out_bytes_amount
		this.state.total_votes_bal += delta_total_balance * this.alice_profile.votes

		const { vars } = await this.alice.readAAStateVars(this.coop_aa)
		expect(vars['user_' + this.aliceAddress]).to.deepCloseTo(this.alice_profile, 13)
		expect(vars.state).to.deepCloseTo(this.state, 13)
		this.check_totals()

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: out_bytes_amount,
			},
		])
	})




	it('Carol tries to withdraw before unlock', async () => {
		const { unit, error } = await this.carol.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10000,
			data: {
				withdraw: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.carol, unit)
		expect(response.response.error).to.be.eq(`your balance unlocks on ${this.carol_profile.unlock_date}`)
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})


	it('Carol withdraws', async () => {
		const timestamp = await this.timetravel('490d')
		this.update_emissions(timestamp)
		this.check_totals()

		const { unit, error } = await this.carol.triggerAaWithData({
			toAddress: this.coop_aa,
			amount: 10000,
			data: {
				withdraw: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.carol, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.carol.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.carolAddress,
				amount: Math.floor(this.carol_profile.balance + this.carol_profile.liquid_balance),
			},
			{
				address: this.governance_aa,
				amount: 1000,
			},
		])
		
		this.state.total_locked -= this.carol_profile.balance
		this.state.total_locked_bytes -= this.carol_profile.bytes_balance
		this.state.total_votes_bal -= this.carol_profile.total_balance * (this.carol_profile.votes || 0)
		this.carol_profile.balance = 0
		this.carol_profile.bytes_balance = 0
		this.carol_profile.liquid_balance = 0
		this.carol_profile.total_balance = 0
		
		const { vars } = await this.carol.readAAStateVars(this.coop_aa)
		expect(vars['user_' + this.carolAddress]).to.deepCloseTo(this.carol_profile, 13)
		expect(vars.state).to.deepCloseTo(this.state, 13)
		this.check_totals()

		this.carolVotes.by_votes_share.sqrt_balance = 0
		const { vars: governance_vars } = await this.carol.readAAStateVars(this.governance_aa)
		const checkVar = (name, value) => {
			expect(governance_vars['support_' + name + '_' + value]).to.eq(0)
			expect(governance_vars['leader_' + name]).to.eq(value)
			expect(governance_vars['choice_' + this.carolAddress + '_' + name]).to.eq(value)
		}
		checkVar('by_votes_share', 0.3)
		expect(governance_vars['votes_' + this.carolAddress]).deep.eq(this.carolVotes)
	})


	after(async () => {
		await this.network.stop()
	})
})
