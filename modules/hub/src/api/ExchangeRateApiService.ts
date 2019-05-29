import * as express from 'express'

import ExchangeRateDao from '../dao/ExchangeRateDao'
import { Logger } from '../util'

import { ApiService } from './ApiService'

const log = new Logger('ExchangeRateApiService')

export default class ExchangeRateApiService extends ApiService<
  ExchangeRateApiServiceHandler
> {
  public namespace: string = 'exchangeRate'
  public routes: any = {
    'GET /': 'doRate',
  }
  public handler: any = ExchangeRateApiServiceHandler
  public dependencies: any = {
    dao: 'ExchangeRateDao',
  }
}

class ExchangeRateApiServiceHandler {
  private dao: ExchangeRateDao

  public async doRate (req: express.Request, res: express.Response): Promise<any> {
    try {
      const rate = await this.dao.latest()
      log.info(`Returning exchange rate: ${JSON.stringify(rate)}`)
      res.send(rate)
    } catch (err) {
      log.error(`Failed to fetch latest exchange rate: ${err}`)
      res.sendStatus(500)
    }
  }
}
