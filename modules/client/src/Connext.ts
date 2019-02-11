import { WithdrawalParameters, ChannelManagerChannelDetails, Sync, ThreadState, addSigToThreadState, ThreadStateUpdate } from './types'
import { DepositArgs, SignedDepositRequestProposal, Omit } from './types'
import { PurchaseRequest } from './types'
import { UpdateRequest } from './types'
import { createStore, Action, applyMiddleware } from 'redux'
require('dotenv').config()
import { EventEmitter } from 'events'
import Web3 = require('web3')
// local imports
import { ChannelManager as TypechainChannelManager } from './contract/ChannelManager'
import { default as ChannelManagerAbi } from './contract/ChannelManagerAbi'
import { Networking } from './helpers/networking'
import BuyController from './controllers/BuyController'
import DepositController from './controllers/DepositController'
import SyncController from './controllers/SyncController'
import StateUpdateController from './controllers/StateUpdateController'
import WithdrawalController from './controllers/WithdrawalController'
import { Utils } from './Utils'
import {
  Validator,
} from './validator'
import {
  ChannelState,
  ChannelStateUpdate,
  Payment,
  addSigToChannelState,
  SyncResult,
  ChannelRow,
  ThreadRow,
  UnsignedThreadState,
  UnsignedChannelState,
  PurchasePayment,
  PurchasePaymentHubResponse,
} from './types'
import { default as Logger } from "./lib/Logger";
import { ConnextStore, ConnextState, PersistentState } from "./state/store";
import { handleStateFlags } from './state/middleware'
import { reducers } from "./state/reducers";
import { isFunction, ResolveablePromise, timeoutPromise } from "./lib/utils";
import { toBN, mul } from './helpers/bn'
import { ExchangeController } from './controllers/ExchangeController'
import { ExchangeRates } from './state/ConnextState/ExchangeRates'
import CollateralController from "./controllers/CollateralController";
import * as actions from './state/actions';
import { AbstractController } from './controllers/AbstractController'
import { EventLog } from 'web3/types';
import { getChannel } from './lib/getChannel';
import ThreadsController from './controllers/ThreadsController';

type Address = string
// anytime the hub is sending us something to sign we need a verify method that verifies that the hub isn't being a jerk

/*********************************
 ****** CONSTRUCTOR TYPES ********
 *********************************/
// contract constructor options
export interface ContractOptions {
  hubAddress: string
  tokenAddress: string
}

// connext constructor options
// NOTE: could extend ContractOptions, doesnt for future readability
export interface ConnextOptions {
  web3: Web3
  hubUrl: string
  contractAddress: string
  hubAddress: Address
  hub?: IHubAPIClient
  tokenAddress?: Address
  tokenName?: string
}

export interface IHubAPIClient {
  getChannel(): Promise<ChannelRow>
  getChannelStateAtNonce(txCountGlobal: number): Promise<ChannelStateUpdate>
  getThreadInitialStates(): Promise<UnsignedThreadState[]>
  getIncomingThreads(): Promise<ThreadRow[]>
  getThreadByParties(partyB: Address, userIsSender: boolean): Promise<ThreadRow>
  sync(txCountGlobal: number, lastThreadUpdateId: number): Promise<Sync | null>
  getExchangerRates(): Promise<ExchangeRates> // TODO: name is typo
  buy<PurchaseMetaType=any, PaymentMetaType=any>(
    meta: PurchaseMetaType,
    payments: PurchasePayment<PaymentMetaType>[],
  ): Promise<PurchasePaymentHubResponse>
  requestDeposit(deposit: SignedDepositRequestProposal, txCount: number, lastThreadUpdateId: number): Promise<Sync>
  requestWithdrawal(withdrawal: WithdrawalParameters, txCountGlobal: number): Promise<Sync>
  requestExchange(weiToSell: string, tokensToSell: string, txCountGlobal: number): Promise<Sync>
  requestCollateral(txCountGlobal: number): Promise<Sync>
  updateHub(updates: UpdateRequest[], lastThreadUpdateId: number): Promise<{
    error: string | null
    updates: Sync
  }>
  updateThread(update: ThreadStateUpdate): Promise<ThreadStateUpdate>
  getLatestChannelState(): Promise<ChannelState | null>
}

class HubAPIClient implements IHubAPIClient {
  private user: Address
  private networking: Networking
  private tokenName?: string

  constructor(user: Address, networking: Networking, tokenName?: string) {
    this.user = user
    this.networking = networking
    this.tokenName = tokenName
  }

  async getLatestChannelState(): Promise<ChannelState | null> {
    try {
      const res = await this.networking.get(`channel/${this.user}/latest-update`)
      return res.data
    } catch (e) {
      if (e.statusCode === 404) {
        console.log(`Channel not found for user ${this.user}`)
        return null
      }
      throw e
    }
  }

  async updateThread(update: ThreadStateUpdate): Promise<ThreadStateUpdate> {
    // 'POST /:sender/to/:receiver/update': 'doUpdateThread'
    try {
      const res = await this.networking.post(`thread/${update.state.sender}/${update.state.receiver}`, {
        update
      })
      return res.data
    } catch (e) {
      if (e.statusCode === 404) {
        throw new Error(`Thread not found for sender ${update.state.sender} and receiver ${update.state.receiver}`)
      }
      throw e
    }
  }

  async getChannel(): Promise<ChannelRow> {
    // get the current channel state and return it
    try {
      const res = await this.networking.get(`channel/${this.user}`)
      return res.data
    } catch (e) {
      if (e.statusCode === 404) {
        throw new Error(`Channel not found for user ${this.user}`)
      }
      throw e
    }
  }

  // return state at specified global nonce
  async getChannelStateAtNonce(
    txCountGlobal: number,
  ): Promise<ChannelStateUpdate> {
    // get the channel state at specified nonce
    try {
      const response = await this.networking.get(
        `channel/${this.user}/update/${txCountGlobal}`
      )
      return response.data
    } catch (e) {
      throw new Error(
        `Cannot find update for user ${this.user} at nonce ${txCountGlobal}, ${e.toString()}`
      )
    }
  }

  async getThreadInitialStates(): Promise<UnsignedThreadState[]> {
    // get the current channel state and return it
    const response = await this.networking.get(
      `thread/${this.user}/initial-states`,
    )
    if (!response.data) {
      return []
    }
    return response.data
  }

  async getIncomingThreads(): Promise<ThreadRow[]> {
    // get the current channel state and return it
    const response = await this.networking.get(
      `thread/${this.user}/incoming`,
    )
    if (!response.data) {
      return []
    }
    return response.data
  }

  // return all threads between 2 addresses
  async getThreadByParties(
    partyB: Address,
    userIsSender: boolean,
  ): Promise<ThreadRow> {
    // get receiver threads
    const response = await this.networking.get(
      `thread/${userIsSender ? this.user : partyB}/to/${userIsSender ? partyB : this.user}`,
    )
    return response.data
  }

  // hits the hubs sync endpoint to return all actionable states
  async sync(
    txCountGlobal: number,
    lastThreadUpdateId: number
  ): Promise<Sync | null> {
    try {
      const res = await this.networking.get(
        `channel/${this.user}/sync?lastChanTx=${txCountGlobal}&lastThreadUpdateId=${lastThreadUpdateId}`,
      )
      return res.data
    } catch (e) {
      if (e.status === 404) {
        return null
      }
      throw e
    }
  }

  async getExchangerRates(): Promise<ExchangeRates> {
    const { data } = await this.networking.get('exchangeRate')
    return data.rates
  }

  async buy<PurchaseMetaType=any, PaymentMetaType=any>(
    meta: PurchaseMetaType,
    payments: PurchasePayment<PaymentMetaType>[],
  ): Promise<PurchasePaymentHubResponse> {
    const { data } = await this.networking.post('payments/purchase', { meta, payments })
    return data
  }

  // post to hub telling user wants to deposit
  requestDeposit = async (
    deposit: Payment,
    txCount: number,
    lastThreadUpdateId: number,
  ): Promise<Sync> => {
    const response = await this.networking.post(
      `channel/${this.user}/request-deposit`,
      {
        depositWei: deposit.amountWei,
        depositToken: deposit.amountToken,
        lastChanTx: txCount,
        lastThreadUpdateId,
      },
    )
    return response.data
  }

  // post to hub telling user wants to withdraw
  requestWithdrawal = async (
    withdrawal: WithdrawalParameters,
    txCountGlobal: number
  ): Promise<Sync> => {
    const response = await this.networking.post(
      `channel/${this.user}/request-withdrawal`,
      { ...withdrawal, lastChanTx: txCountGlobal },
    )
    return response.data
  }

  async requestExchange(weiToSell: string, tokensToSell: string, txCountGlobal: number): Promise<Sync> {
    const { data } = await this.networking.post(
      `channel/${this.user}/request-exchange`,
      { weiToSell, tokensToSell, lastChanTx: txCountGlobal }
    )
    return data
  }

  // performer calls this when they wish to start a show
  // return the proposed deposit fro the hub which should then be verified and cosigned
  requestCollateral = async (txCountGlobal: number): Promise<Sync> => {
    // post to hub
    const response = await this.networking.post(
      `channel/${this.user}/request-collateralization`,
      {
        lastChanTx: txCountGlobal
      },
    )
    return response.data
  }

  // post to hub to batch verify state updates
  updateHub = async (
    updates: UpdateRequest[],
    lastThreadUpdateId: number,
  ): Promise<{ error: string | null, updates: Sync }> => {
    // post to hub
    const response = await this.networking.post(
      `channel/${this.user}/update`,
      {
        lastThreadUpdateId,
        updates,
      },
    )
    return response.data
  }
}

// connext constructor options
// NOTE: could extend ContractOptions, doesnt for future readability
export interface ConnextOptions {
  web3: Web3
  hubUrl: string
  contractAddress: string
  hubAddress: Address
  hub?: IHubAPIClient
  tokenAddress?: Address
  tokenName?: string
}

export abstract class IWeb3TxWrapper {
  abstract awaitEnterMempool(): Promise<void>

  abstract awaitFirstConfirmation(): Promise<void>
}

/**
 * A wrapper around the Web3 PromiEvent
 * (https://web3js.readthedocs.io/en/1.0/callbacks-promises-events.html#promievent)
 * that makes the different `await` behaviors explicit.
 *
 * For example:
 *
 *   > const tx = channelManager.userAuthorizedUpdate(...)
 *   > await tx.awaitEnterMempool()
 */
export class Web3TxWrapper extends IWeb3TxWrapper {
  private tx: any

  private address: string
  private name: string
  private onTxHash = new ResolveablePromise<void>()
  private onFirstConfirmation = new ResolveablePromise<void>()

  constructor(address: string, name: string, tx: any) {
    super()

    this.address = address
    this.name = name
    this.tx = tx

    tx.once('transactionHash', (hash: string) => {
      console.log(`Sending ${this.name} to ${this.address}: in mempool: ${hash}`)
      this.onTxHash.resolve()
    })

    tx.once('confirmation', (confirmation: number, receipt: any) => {
      console.log(`Sending ${this.name} to ${this.address}: confirmed:`, receipt)
      this.onFirstConfirmation.resolve()
    })
  }

  awaitEnterMempool(): Promise<void> {
    return this.onTxHash as any
  }

  awaitFirstConfirmation(): Promise<void> {
    return this.onFirstConfirmation as any
  }
}

export type ChannelManagerChannelDetails = {
  txCountGlobal: number
  txCountChain: number
  threadRoot: string
  threadCount: number
  exitInitiator: string
  channelClosingTime: number
  status: string
}

export interface IChannelManager {
  gasMultiple: number
  userAuthorizedUpdate(state: ChannelState): Promise<IWeb3TxWrapper>
  getPastEvents(user: Address, eventName: string, fromBlock: number): Promise<EventLog[]>
  getChannelDetails(user: string): Promise<ChannelManagerChannelDetails>
  startExit(state: ChannelState): Promise<IWeb3TxWrapper>
  startExitWithUpdate(state: ChannelState): Promise<IWeb3TxWrapper>
  emptyChannelWithChallenge(state: ChannelState): Promise<IWeb3TxWrapper>
  emptyChannel(state: ChannelState): Promise<IWeb3TxWrapper>
  startExitThread(state: ChannelState, threadState: ThreadState, proof: any): Promise<IWeb3TxWrapper>
  startExitThreadWithUpdate(state: ChannelState, threadInitialState: ThreadState, threadUpdateState: ThreadState, proof: any): Promise<IWeb3TxWrapper>
  challengeThread(state: ChannelState, threadState: ThreadState): Promise<IWeb3TxWrapper>
  emptyThread(state: ChannelState, threadState: ThreadState, proof: any): Promise<IWeb3TxWrapper>
  nukeThreads(state: ChannelState): Promise<IWeb3TxWrapper>
}

export class ChannelManager implements IChannelManager {
  address: string
  cm: TypechainChannelManager
  gasMultiple: number

  constructor(web3: any, address: string, gasMultiple: number) {
    this.address = address
    this.cm = new web3.eth.Contract(ChannelManagerAbi.abi, address) as any
    this.gasMultiple = gasMultiple
  }

  async getPastEvents(user: Address, eventName: string, fromBlock: number) {
    const events = await this.cm.getPastEvents(
      eventName,
      {
        filter: { user },
        fromBlock,
        toBlock: "latest",
      }
    )
    return events
  }

  async userAuthorizedUpdate(state: ChannelState) {
    // deposit on the contract
    const call = this.cm.methods.userAuthorizedUpdate(
      state.recipient, // recipient
      [
        state.balanceWeiHub,
        state.balanceWeiUser,
      ],
      [
        state.balanceTokenHub,
        state.balanceTokenUser,
      ],
      [
        state.pendingDepositWeiHub,
        state.pendingWithdrawalWeiHub,
        state.pendingDepositWeiUser,
        state.pendingWithdrawalWeiUser,
      ],
      [
        state.pendingDepositTokenHub,
        state.pendingWithdrawalTokenHub,
        state.pendingDepositTokenUser,
        state.pendingWithdrawalTokenUser,
      ],
      [state.txCountGlobal, state.txCountChain],
      state.threadRoot,
      state.threadCount,
      state.timeout,
      state.sigHub!,
    )

    const sendArgs = {
      from: state.user,
      value: state.pendingDepositWeiUser,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    
    sendArgs.gas = toBN(Math.ceil(gasEstimate * this.gasMultiple))
    return new Web3TxWrapper(this.address, 'userAuthorizedUpdate', call.send(sendArgs))
  }

  async startExit(state: ChannelState) {
    const call = this.cm.methods.startExit(
      state.user
    )

    const sendArgs = {
      from: state.user,
      value: 0,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    sendArgs.gas = toBN(gasEstimate * this.gasMultiple)
    return new Web3TxWrapper(this.address, 'startExit', call.send(sendArgs))
  }

  async startExitWithUpdate(state: ChannelState) {
    const call = this.cm.methods.startExitWithUpdate(
      [ state.user, state.recipient ],
      [
        state.balanceWeiHub,
        state.balanceWeiUser,
      ],
      [
        state.balanceTokenHub,
        state.balanceTokenUser,
      ],
      [
        state.pendingDepositWeiHub,
        state.pendingWithdrawalWeiHub,
        state.pendingDepositWeiUser,
        state.pendingWithdrawalWeiUser,
      ],
      [
        state.pendingDepositTokenHub,
        state.pendingWithdrawalTokenHub,
        state.pendingDepositTokenUser,
        state.pendingWithdrawalTokenUser,
      ],
      [state.txCountGlobal, state.txCountChain],
      state.threadRoot,
      state.threadCount,
      state.timeout,
      state.sigHub as string,
      state.sigUser as string,
    )

    const sendArgs = {
      from: state.user,
      value: 0,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    sendArgs.gas = toBN(gasEstimate * this.gasMultiple)
    return new Web3TxWrapper(this.address, 'startExitWithUpdate', call.send(sendArgs))
  }

  async emptyChannelWithChallenge(state: ChannelState) {
    const call = this.cm.methods.emptyChannelWithChallenge(
      [ state.user, state.recipient ],
      [
        state.balanceWeiHub,
        state.balanceWeiUser,
      ],
      [
        state.balanceTokenHub,
        state.balanceTokenUser,
      ],
      [
        state.pendingDepositWeiHub,
        state.pendingWithdrawalWeiHub,
        state.pendingDepositWeiUser,
        state.pendingWithdrawalWeiUser,
      ],
      [
        state.pendingDepositTokenHub,
        state.pendingWithdrawalTokenHub,
        state.pendingDepositTokenUser,
        state.pendingWithdrawalTokenUser,
      ],
      [state.txCountGlobal, state.txCountChain],
      state.threadRoot,
      state.threadCount,
      state.timeout,
      state.sigHub as string,
      state.sigUser as string,
    )

    const sendArgs = {
      from: state.user,
      value: 0,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    sendArgs.gas = toBN(gasEstimate * this.gasMultiple)
    return new Web3TxWrapper(this.address, 'emptyChannelWithChallenge', call.send(sendArgs))
  }

  async emptyChannel(state: ChannelState) {
    const call = this.cm.methods.emptyChannel(
      state.user,
    )

    const sendArgs = {
      from: state.user,
      value: 0,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    sendArgs.gas = toBN(gasEstimate * this.gasMultiple)
    return new Web3TxWrapper(this.address, 'emptyChannel', call.send(sendArgs))
  }

  async startExitThread(state: ChannelState, threadState: ThreadState, proof: any) {
    const call = this.cm.methods.startExitThread(
      state.user,
      threadState.sender,
      threadState.receiver,
      threadState.threadId,
      [threadState.balanceWeiSender, threadState.balanceWeiReceiver],
      [threadState.balanceTokenSender, threadState.balanceTokenReceiver],
      proof,
      threadState.sigA,
    )

    const sendArgs = {
      from: state.user,
      value: 0,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    sendArgs.gas = toBN(gasEstimate * this.gasMultiple)
    return new Web3TxWrapper(this.address, 'startExitThread', call.send(sendArgs))
  }

  async startExitThreadWithUpdate(state: ChannelState, threadInitialState: ThreadState, threadUpdateState: ThreadState, proof: any) {
    const call = this.cm.methods.startExitThreadWithUpdate(
      state.user,
      [threadInitialState.sender, threadInitialState.receiver],
      threadInitialState.threadId,
      [threadInitialState.balanceWeiSender, threadInitialState.balanceWeiReceiver],
      [threadInitialState.balanceTokenSender, threadInitialState.balanceTokenReceiver],
      proof,
      threadInitialState.sigA,
      [threadUpdateState.balanceWeiSender, threadUpdateState.balanceWeiReceiver],
      [threadUpdateState.balanceTokenSender, threadUpdateState.balanceTokenReceiver],
      threadUpdateState.txCount,
      threadUpdateState.sigA
    )

    const sendArgs = {
      from: state.user,
      value: 0,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    sendArgs.gas = toBN(gasEstimate * this.gasMultiple)
    return new Web3TxWrapper(this.address, 'startExitThreadWithUpdate', call.send(sendArgs))
  }

  async challengeThread(state: ChannelState, threadState: ThreadState) {
    const call = this.cm.methods.challengeThread(
      threadState.sender, 
      threadState.receiver,
      threadState.threadId,
      [threadState.balanceWeiSender, threadState.balanceWeiReceiver],
      [threadState.balanceTokenSender, threadState.balanceTokenReceiver],
      threadState.txCount,
      threadState.sigA
    )

    const sendArgs = {
      from: state.user,
      value: 0,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    sendArgs.gas = toBN(gasEstimate * this.gasMultiple)
    return new Web3TxWrapper(this.address, 'challengeThread', call.send(sendArgs))
  }

  async emptyThread(state: ChannelState, threadState: ThreadState, proof: any) {
    const call = this.cm.methods.emptyThread(
      state.user,
      threadState.sender,
      threadState.receiver,
      threadState.threadId,
      [threadState.balanceWeiSender, threadState.balanceWeiReceiver],
      [threadState.balanceTokenSender, threadState.balanceTokenReceiver],
      proof,
      threadState.sigA,
    )

    const sendArgs = {
      from: state.user,
      value: 0,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    sendArgs.gas = toBN(gasEstimate * this.gasMultiple)
    return new Web3TxWrapper(this.address, 'emptyThread', call.send(sendArgs))
  }

  async nukeThreads(state: ChannelState) {
    const call = this.cm.methods.nukeThreads(
      state.user
    )

    const sendArgs = {
      from: state.user,
      value: 0,
    } as any
    const gasEstimate = await call.estimateGas(sendArgs)
    sendArgs.gas = toBN(gasEstimate * this.gasMultiple)
    return new Web3TxWrapper(this.address, 'nukeThreads', call.send(sendArgs))
  }

  async getChannelDetails(user: string): Promise<ChannelManagerChannelDetails> {
    const res = await this.cm.methods.getChannelDetails(user).call({ from: user })
    return {
      txCountGlobal: +res[0],
      txCountChain: +res[1],
      threadRoot: res[2],
      threadCount: +res[3],
      exitInitiator: res[4],
      channelClosingTime: +res[5],
      status: res[6],
    }
  }

}

export interface ConnextClientOptions {
  web3: Web3
  hubUrl: string
  contractAddress: string
  hubAddress: Address
  tokenAddress: Address
  tokenName: string
  user: string
  gasMultiple?: number

  // Clients should pass in these functions which the ConnextClient will use
  // to save and load the persistent portions of its internal state (channels,
  // threads, etc).
  loadState?: () => Promise<string | null>
  saveState?: (state: string) => Promise<any>

  getLogger?: (name: string) => Logger

  // Optional, useful for dependency injection
  hub?: IHubAPIClient
  store?: ConnextStore
  contract?: IChannelManager
}


/**
 * Used to get an instance of ConnextClient.
 */
export function getConnextClient(opts: ConnextClientOptions): ConnextClient {
  return new ConnextInternal(opts)
}

/**
 * The external interface to the Connext client, used by the Wallet.
 *
 * Create an instance with:
 *
 *  > const client = getConnextClient({...})
 *  > client.start() // start polling
 *  > client.on('onStateChange', state => {
 *  .   console.log('Connext state changed:', state)
 *  . })
 *
 */
export abstract class ConnextClient extends EventEmitter {
  opts: ConnextClientOptions
  internal: ConnextInternal

  constructor(opts: ConnextClientOptions) {
    super()

    this.opts = opts
    this.internal = this as any
  }

  /**
   * Starts the stateful portions of the Connext client.
   *
   * Note: the full implementation lives in ConnextInternal.
   */
  async start() {
  }

  /**
   * Stops the stateful portions of the Connext client.
   *
   * Note: the full implementation lives in ConnextInternal.
   */
  async stop() {
  }

  async deposit(payment: Payment): Promise<void> {
    await this.internal.depositController.requestUserDeposit(payment)
  }

  async exchange(toSell: string, currency: "wei" | "token"): Promise<void> {
    await this.internal.exchangeController.exchange(toSell, currency)
  }

  async buy(purchase: PurchaseRequest): Promise<{ purchaseId: string }> {
    return await this.internal.buyController.buy(purchase)
  }

  async withdraw(withdrawal: WithdrawalParameters): Promise<void> {
    await this.internal.withdrawalController.requestUserWithdrawal(withdrawal)
  }

  async requestCollateral(): Promise<void> {
    await this.internal.collateralController.requestCollateral()
  }
}

/**
 * The "actual" implementation of the Connext client. Internal components
 * should use this type, as it provides access to the various controllers, etc.
 */
export class ConnextInternal extends ConnextClient {
  store: ConnextStore
  hub: IHubAPIClient
  utils = new Utils()
  validator: Validator
  contract: IChannelManager

  // Controllers
  syncController: SyncController
  buyController: BuyController
  depositController: DepositController
  exchangeController: ExchangeController
  withdrawalController: WithdrawalController
  stateUpdateController: StateUpdateController
  collateralController: CollateralController
  threadsController: ThreadsController

  constructor(opts: ConnextClientOptions) {
    super(opts)

    // Internal things
    // The store shouldn't be used by anything before calling `start()`, so
    // leave it null until then.
    this.store = null as any

    console.log('Using hub', opts.hub ? 'provided by caller' : `at ${this.opts.hubUrl}`)
    this.hub = opts.hub || new HubAPIClient(
      this.opts.user,
      new Networking(this.opts.hubUrl),
      this.opts.tokenName,
    )

    this.validator = new Validator(opts.web3, opts.hubAddress)
    this.contract = opts.contract || new ChannelManager(opts.web3, opts.contractAddress, opts.gasMultiple || 1.5)

    // Controllers
    this.exchangeController = new ExchangeController('ExchangeController', this)
    this.syncController = new SyncController('SyncController', this)
    this.depositController = new DepositController('DepositController', this)
    this.buyController = new BuyController('BuyController', this)
    this.withdrawalController = new WithdrawalController('WithdrawalController', this)
    this.stateUpdateController = new StateUpdateController('StateUpdateController', this)
    this.collateralController = new CollateralController('CollateralController', this)
    this.threadsController = new ThreadsController('ThreadsController', this)
  }

  private getControllers(): AbstractController[] {
    const res: any[] = []
    for (let key of Object.keys(this)) {
      const val = (this as any)[key]
      const isController = (
        val &&
        isFunction(val['start']) &&
        isFunction(val['stop']) &&
        val !== this
      )
      if (isController)
        res.push(val)
    }
    return res
  }

  async withdrawal(params: WithdrawalParameters): Promise<void> {
    await this.withdrawalController.requestUserWithdrawal(params)
  }

  async start() {
    this.store = await this.getStore()
    this.store.subscribe(() => {
      const state = this.store.getState()
      this.emit('onStateChange', state)
      this._saveState(state)
    })

    // Start all controllers
    for (let controller of this.getControllers()) {
      console.log('Starting:', controller.name)
      await controller.start()
      console.log('Done!', controller.name, 'started.')
    }

    await super.start()
  }

  async stop() {
    // Stop all controllers
    for (let controller of this.getControllers())
      await controller.stop()

    await super.stop()
  }


  dispatch(action: Action): void {
    this.store.dispatch(action)
  }

  async signChannelState(state: UnsignedChannelState): Promise<ChannelState> {
    if (
      state.user != this.opts.user ||
      state.contractAddress != this.opts.contractAddress
    ) {
      throw new Error(
        `Refusing to sign channel state update which changes user or contract: ` +
        `expected user: ${this.opts.user}, expected contract: ${this.opts.contractAddress} ` +
        `actual state: ${JSON.stringify(state)}`
      )
    }

    const hash = this.utils.createChannelStateHash(state)

    const { user, hubAddress } = this.opts
    const sig = await (
      process.env.DEV || user === hubAddress
        ? this.opts.web3.eth.sign(hash, user)
        : (this.opts.web3.eth.personal.sign as any)(hash, user)
    )

    console.log(`Signing channel state ${state.txCountGlobal}: ${sig}`, state)
    return addSigToChannelState(state, sig, true)
  }

  async signThreadState(state: UnsignedThreadState): Promise<ThreadState> {
    const userInThread = state.sender == this.opts.user || state.receiver == this.opts.user
    if (
      !userInThread ||
      state.contractAddress != this.opts.contractAddress
    ) {
      throw new Error(
        `Refusing to sign thread state update which changes user or contract: ` +
        `expected user: ${this.opts.user}, expected contract: ${this.opts.contractAddress} ` +
        `actual state: ${JSON.stringify(state)}`
      )
    }

    const hash = this.utils.createThreadStateHash(state)

    const sig = await (
      process.env.DEV
        ? this.opts.web3.eth.sign(hash, this.opts.user)
        : (this.opts.web3.eth.personal.sign as any)(hash, this.opts.user)
    )

    console.log(`Signing thread state ${state.txCount}: ${sig}`, state)
    return addSigToThreadState(state, sig)
  }

  public async signDepositRequestProposal(args: Omit<SignedDepositRequestProposal, 'sigUser'>, ): Promise<SignedDepositRequestProposal> {
    const hash = this.utils.createDepositRequestProposalHash(args)
    const sig = await (
      process.env.DEV
        ? this.opts.web3.eth.sign(hash, this.opts.user)
        : (this.opts.web3.eth.personal.sign as any)(hash, this.opts.user)
    )

    console.log(`Signing deposit request ${args}. Sig: ${sig}`)
    return { ...args, sigUser: sig }
  }

  public async getContractEvents(eventName: string, fromBlock: number) {
    return this.contract.getPastEvents(this.opts.user, eventName, fromBlock)
  }

  protected _latestState: PersistentState | null = null
  protected _saving: Promise<void> = Promise.resolve()
  protected _savePending = false

  protected async _saveState(state: ConnextState) {
    if (!this.opts.saveState)
      return

    if (this._latestState === state.persistent)
      return

    this._latestState = state.persistent
    if (this._savePending)
      return

    this._savePending = true

    this._saving = new Promise((res, rej) => {
      // Only save the state after all the currently pending operations have
      // completed to make sure that subsequent state updates will be atomic.
      setTimeout(async () => {
        let err = null
        try {
          await this._saveLoop()
        } catch (e) {
          err = e
        }
        // Be sure to set `_savePending` to `false` before resolve/reject
        // in case the state changes during res()/rej()
        this._savePending = false
        return err ? rej(err) : res()
      }, 1)
    })
  }

  /**
   * Because it's possible that the state will continue to be updated while
   * a previous state is saving, loop until the state doesn't change while
   * it's being saved before we return.
   */
  protected async _saveLoop() {
    let result: Promise<any> | null = null
    while (true) {
      const state = this._latestState!
      result = this.opts.saveState!(JSON.stringify(state))

      // Wait for any current save to finish, but ignore any error it might raise
      const [timeout, _] = await timeoutPromise(
        result.then(null, () => null),
        10 * 1000,
      )
      if (timeout) {
        console.warn(
          'Timeout (10 seconds) while waiting for state to save. ' +
          'This error will be ignored (which may cause data loss). ' +
          'User supplied function that has not returned:',
          this.opts.saveState
        )
      }

      if (this._latestState == state)
        break
    }
  }

  /**
   * Waits for any persistent state to be saved.
   *
   * If the save fails, the promise will reject.
   */
  awaitPersistentStateSaved(): Promise<void> {
    return this._saving
  }

  protected async getStore(): Promise<ConnextStore> {
    if (this.opts.store)
      return this.opts.store

    const state = new ConnextState()
    state.persistent.channel = {
      ...state.persistent.channel,
      contractAddress: this.opts.contractAddress,
      user: this.opts.user,
      recipient: this.opts.user,
    }
    state.persistent.latestValidState = state.persistent.channel

    if (this.opts.loadState) {
      const loadedState = await this.opts.loadState()
      if (loadedState)
        state.persistent = JSON.parse(loadedState)
    }
    return createStore(reducers, state, applyMiddleware(handleStateFlags))
  }

  getLogger(name: string): Logger {
    return {
      source: name,
      async logToApi(...args: any[]) {
        console.log(`${name}:`, ...args)
      },
    }

  }
}
