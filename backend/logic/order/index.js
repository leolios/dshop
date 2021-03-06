const randomstring = require('randomstring')
const util = require('ethereumjs-util')
const get = require('lodash/get')

const { Sentry } = require('../../sentry')
const { Order, Product } = require('../../models')

const sendNewOrderEmail = require('../../utils/emails/newOrder')
const discordWebhook = require('../../utils/discordWebhook')
const { autoFulfillOrder } = require('../printful')
const { OrderPaymentStatuses, OrderPaymentTypes } = require('../../utils/enums')
const { decryptShopOfferData } = require('../../utils/offer')
const { getLogger } = require('../../utils/logger')
const { getConfig } = require('../../utils/encryptedConfig')

const { validateDiscountOnOrder } = require('../discount')
const { processStripeRefund } = require('../payments/stripe')
const { processPayPalRefund } = require('../payments/paypal')
const {
  readProductsFileFromWeb,
  readProductDataFromWeb
} = require('../products')

const log = getLogger('logic.order')

const { IS_TEST } = require('../../utils/const')

/**
 * Returns a new order id. Returns its full-qualified and short form.
 * Format: <networkId>-<contractVersion>-<listingId>-<shopID>-<randomId>.
 * Example: 1-001-12345-6789-XCQ69BTJ
 *
 * @param {models.Network} network
 * @param {models.Shop} shop
 * @returns {fqId: string, shortId: string}
 */
function createOrderId(network, shop) {
  const shortId = randomstring.generate({
    readable: true,
    charset: 'alphanumeric',
    capitalization: 'uppercase',
    length: 8
  })
  // Note: network.listingId is fully qualified and has format <networkId>-<contractVersion>-<listingId>.
  const fqId = `${network.listingId}-${shop.id}-${shortId}`
  return { fqId, shortId }
}

/**
 * Returns the short version of an order id, which is an 8 characters long alphanumerical id.
 * It is the preferred form to use in external communication with merchants and buyers.
 *
 * @param {string} fqOrderId: a fully qualified order id.
 */
function getShortOrderId(fqOrderId) {
  const parts = fqOrderId.split('-')
  if (parts.length !== 5) {
    throw new Error(`Invalid order id ${fqOrderId}`)
  }
  const shortOrderId = parts[4]
  if (shortOrderId.length !== 8) {
    throw new Error(`Invalid order id ${fqOrderId}`)
  }
  return shortOrderId
}

/**
 * Utility method to extract the payment type from the encrypted offer data.
 * @param {object} offerData
 * @returns {enums.OrderPaymentTypes}
 */
function getPaymentType(offerData) {
  const paymentMethodId = get(offerData, 'paymentMethod.id')
  let paymentType
  switch (paymentMethodId) {
    case 'crypto':
      paymentType = OrderPaymentTypes.CryptoCurrency
      break
    case 'stripe':
      paymentType = OrderPaymentTypes.Stripe
      break
    case 'paypal':
      paymentType = OrderPaymentTypes.PayPal
      break
    case 'uphold':
      paymentType = OrderPaymentTypes.Uphold
      break
    default:
      paymentType = OrderPaymentTypes.Offline
  }
  return paymentType
}

/**
 * Checks an offer is valid by comparing data from the cart to the shop's data.
 *
 * @param {Model.shop} shop
 * @param {object} networkConfig
 * @param {object} order
 * @returns {Promise<{error: string}|{valid: true}>}
 */
async function validateOfferData(shop, networkConfig, order) {
  let readProductsFile = readProductsFileFromWeb
  let readProductData = readProductDataFromWeb
  if (IS_TEST) {
    const {
      mockReadProductsFileFromWeb,
      mockReadProductDataFromWeb
    } = require('../../test/utils')
    readProductsFile = mockReadProductsFileFromWeb
    readProductData = mockReadProductDataFromWeb
  }

  // Get the cart data from the order
  const cart = order.data
  if (!cart) {
    return { error: 'Invalid order: No cart' }
  }
  const items = cart.items
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { error: 'Invalid order: No item in cart' }
  }

  // Check the products in the cart exist and the correctness of their price.
  // We fetch the data from the published shop since that is what the
  // checkout page uses (as opposed to from the disk which could have changes
  // that haven't been published yet by the merchant).
  const products = await readProductsFile(shop, networkConfig)
  let subTotal = 0
  for (const item of items) {
    // Find the item in the catalog of products.
    const product = products.find((p) => p.id === item.product)
    if (!product) {
      return { error: `Invalid order: Unknown product ${item.product} in cart` }
    }

    // If the item has a variant, fetch the product file to get the variant price.
    // Otherwise use the price from the product catalog.
    let productPrice
    if (item.variant) {
      const productData = await readProductData(
        shop,
        networkConfig,
        item.product
      )
      const variants = productData.variants
      if (!variants || !Array.isArray(variants) || variants.length === 0) {
        return { error: `Invalid order: Unknown variant ${item.variant}` }
      }
      const variant = variants.find((v) => v.id === item.variant)
      if (!variant) {
        return { error: `Invalid order: Unknown variant ${item.variant}` }
      }
      productPrice = variant.price
    } else {
      productPrice = product.price
    }

    // Check the item's price in the cart matches with the price from the shop.
    if (productPrice !== item.price) {
      return {
        error: `Incorrect price ${item.price} for product ${item.product}`
      }
    }
    subTotal += item.quantity * item.price
  }

  // Check the subtotal.
  if (subTotal !== cart.subTotal) {
    return { error: 'Invalid order: Subtotal' }
  }

  return { valid: true }
}

/**
 * Logic for creating a new order in the system.
 *
 * @param {models.Network} network
 * @param {object} networkConfig
 * @param {models.Shop} shop
 * @param {object} shopConfig
 * @param {object} offer: JSON of the unencrypted offer data.
 * @param {string} offerIpfsHash: IPFS hash of the unencrypted offer data.
 * @param {string || null} offerId: blockchain fully-qualified offer ID or null in case of an off-chain offer.
 * @param {object || null} event: blockchain OfferCreated event or null in case of an off-chain offer.
 * @param {boolean} skipEmail: If true, do not send email to the buyer/seller.
 * @param {boolean} skipDiscord: If true, do not send Discord notification to the system administrator.
 * @param {enums.OrderPaymentTypes} paymentType: Optional. Payment type of the order.
 *   It is not passed for on-chain transactions and in that case the logic gets the
 *   paymentType by inspecting the encrypted offer data.
 * @param {enums.OrderPaymentStatuses} paymentStatus: Payment status override
 * @returns {Promise<models.Order>}
 */
async function processNewOrder({
  network,
  networkConfig,
  shop,
  shopConfig,
  offer,
  offerIpfsHash,
  offerId,
  event,
  skipEmail,
  skipDiscord,
  paymentType,
  paymentStatus: _paymentStatus
}) {
  // Generate a short unique order id and the fully qualified id.
  const { fqId, shortId } = createOrderId(network, shop)

  // Load the encrypted data from IPFS and decrypt it.
  const encryptedHash = offer.encryptedData
  if (!encryptedHash) {
    throw new Error('No encrypted data found')
  }
  log.info(`Fetching encrypted offer data with hash ${encryptedHash}`)
  const data = await decryptShopOfferData(shop, encryptedHash)

  // On-chain marketplace transactions do not pass the paymentType. Extract it from the offer data.
  if (offerId) {
    paymentType = getPaymentType(data)
  }

  // Decorate the data with additional blockchain specific info before storing it in the DB.
  if (event) {
    data.tx = event.transactionHash
  }

  // Extract the optional paymentCode data from the offer.
  // It is populated for example in case of a Credit Card payment.
  const paymentCode = offer.paymentCode || null

  // Let the status be `Pending` by default for Offline payments.
  const paymentStatus =
    _paymentStatus ||
    (paymentType === OrderPaymentTypes.Offline
      ? OrderPaymentStatuses.Pending
      : OrderPaymentStatuses.Paid)

  // Insert a new row in the orders DB table.
  const orderObj = {
    networkId: network.networkId,
    shopId: shop.id,
    fqId,
    shortId,
    data,
    paymentStatus,
    paymentType,
    paymentCode,
    ipfsHash: offerIpfsHash,
    encryptedIpfsHash: encryptedHash,
    total: data.total,
    currency: data.currency
  }
  if (event) {
    // Offer was created on-chain. Record blockchain specific data from the event.
    orderObj.offerId = offerId
    orderObj.offerStatus = event.eventName
    orderObj.createdAt = new Date(event.timestamp * 1000)
    orderObj.createdBlock = event.blockNumber
    orderObj.updatedBlock = event.blockNumber
  } else {
    // Offer was created off-chain.
    orderObj.createdAt = new Date()
  }
  if (data.referrer) {
    orderObj.referrer = util.toChecksumAddress(data.referrer)
    orderObj.commissionPending = Math.floor(data.subTotal / 200)
  }

  //
  // Validation steps.
  //
  // Note: If there is an error (ex: item out of stock, unavail discount, ...)
  // we store the error in the order data but we don't throw. The reason
  // is that order processing is asynchronous. The buyer already exited
  // checkout successfully. So we record the order with errors in the DB
  // and let the merchant decide if they want to refund the buyer.
  const errorData = { error: [] }

  const offerResult = await validateOfferData(shop, networkConfig, orderObj)
  if (!offerResult.valid) {
    const offerError = offerResult.error
    errorData.offerError = offerError
    errorData.error.push(offerError)
  }

  const discountResult = await validateDiscountOnOrder(orderObj)
  if (!discountResult.valid) {
    const discountError = discountResult.error
    errorData.discountError = discountError
    errorData.error.push(discountError)
  }

  const inventoryResult = await updateInventoryData(shop, shopConfig, data)
  if (!inventoryResult.success) {
    const inventoryError = inventoryResult.error
    errorData.inventoryError = inventoryError
    errorData.error.push(inventoryError)
  }

  // If at least 1 error was found, add the error data to the order data.
  if (errorData.error.length > 0) {
    orderObj.data = { ...orderObj.data, ...errorData }
  }

  //
  // Create the order in the DB.
  //
  const order = await Order.create(orderObj)
  log.info(`Saved order ${order.fqId} to DB.`)

  // Note: we only fulfill the order if the payment status is 'Paid'.
  // If the payment is still pending, the order will get fulfilled
  // at the time the payment status gets updated to 'Paid' (for ex. when the
  // merchant marks the payment as received for the order via the admin tool.
  // TODO:
  //  - Move order fulfillment to a queue.
  //  - Should we still auto-fulfill in case of an error in inventory or discount validation?
  if (
    shopConfig.printful &&
    shopConfig.printfulAutoFulfill &&
    paymentStatus === OrderPaymentStatuses.Paid
  ) {
    await autoFulfillOrder(order, shopConfig, shop)
  }

  // Send notifications via email and discord.
  // This section is not critical so we log errors but do not throw any
  // exception in order to avoid triggering a queue retry which would
  // cause the order to get recorded multiple times in the DB.
  if (!skipEmail) {
    try {
      await sendNewOrderEmail({
        orderId: shortId,
        order,
        shop,
        cart: data,
        network
      })
    } catch (e) {
      log.error('Email sending failure:', e)
      Sentry.captureException(e)
    }
  }
  if (!skipDiscord) {
    try {
      await discordWebhook.postNewOrderMessage({
        url: networkConfig.discordWebhook,
        orderId: fqId,
        shopName: shop.name,
        total: `${(data.total / 100).toFixed(2)} ${data.currency}`,
        items: data.items.map((i) => i.title).filter((t) => t)
      })
    } catch (e) {
      log.error('Discord webhook failure:', e)
      Sentry.captureException(e)
    }
  }

  return order
}

const validPaymentStateTransitions = {
  [OrderPaymentStatuses.Refunded]: [],
  [OrderPaymentStatuses.Rejected]: [],
  [OrderPaymentStatuses.Pending]: [
    OrderPaymentStatuses.Paid,
    OrderPaymentStatuses.Rejected,
    OrderPaymentStatuses.Refunded
  ],
  [OrderPaymentStatuses.Paid]: [OrderPaymentStatuses.Refunded]
}

/**
 * Returns the validity of the payment state
 * transition on an order
 * @param {model.Order} order
 * @param {enums.OrderPaymentStatuses} newState
 *
 * @returns {Boolean} true if valid
 */
const isValidTransition = function (order, newState) {
  return get(
    validPaymentStateTransitions,
    order.paymentStatus,
    validPaymentStateTransitions[OrderPaymentStatuses.Pending]
  ).includes(newState)
}

/**
 * Updates the payment state of an order
 * @param {model.Order} order
 * @param {enums.OrderPaymentStatuses} newState
 * @param {mode.Shop} shop
 *
 * @returns {{
 *  success {Boolean}
 *  reason {String|null} error message if any
 * }}
 */
async function updatePaymentStatus(order, newState, shop) {
  if (order.paymentStatus === newState) {
    // No change, Ignore
    return { success: true }
  }

  if (!isValidTransition(order, newState)) {
    return {
      reason: `Cannot change payment state from ${order.paymentStatus} to ${newState}`
    }
  }

  const shopConfig = getConfig(shop.config)

  let refundError = get(order, 'data.refundError')
  if (newState === OrderPaymentStatuses.Refunded) {
    // Initiate a refund in case of Stripe and PayPal
    switch (order.paymentType) {
      case OrderPaymentTypes.CreditCard:
        refundError = await processStripeRefund({ shop, order })
        break
      case OrderPaymentTypes.PayPal:
        refundError = await processPayPalRefund({ shop, order })
        break
    }
  } else if (newState === OrderPaymentStatuses.Paid) {
    if (shopConfig.printful && shopConfig.printfulAutoFulfill) {
      await autoFulfillOrder(order, shopConfig, shop)
    }
  }

  const shouldUpdateInventory =
    shopConfig.inventory &&
    !order.data.inventoryError &&
    [
      OrderPaymentStatuses.Refunded,
      OrderPaymentStatuses.Rejected,
      OrderPaymentStatuses.Paid
    ].includes(newState)

  let inventoryError
  if (shouldUpdateInventory) {
    const { error } = await updateInventoryData(
      shop,
      shopConfig,
      order.data,
      newState !== OrderPaymentStatuses.Paid
    )
    inventoryError = error
  }

  await order.update({
    paymentStatus: newState,
    data: {
      ...order.data,
      refundError,
      inventoryError
    }
  })

  return { success: !refundError, reason: refundError }
}

/**
 * Marks and processes a deferred payment, used for
 * PayPal eCheck payments
 *
 * @param {String} paymentCode external payment ID, used to find order
 * @param {enums.OrderPaymentTypes} paymentType
 * @param {model.Shop} shop
 * @param {Object} event the webhook event
 *
 * @returns {Boolean} true if existing order has been marked as paid
 */
async function processDeferredPayment(paymentCode, paymentType, shop, event) {
  // Check if it is an existing pending order
  const order = await Order.findOne({
    where: {
      paymentCode,
      paymentType,
      shopId: shop.id,
      paymentStatus: OrderPaymentStatuses.Pending
    }
  })

  const shopId = shop.id

  if (order) {
    // If yes, mark it as Paid, instead of
    // creating a new order.

    const { success, reason } = await updatePaymentStatus(
      order,
      OrderPaymentStatuses.Paid,
      shop
    )

    if (!success) {
      const error = new Error(`[Shop ${shopId}] ${reason}`)
      Sentry.captureException(error)

      throw error
    }

    log.info(
      `[Shop ${shopId}] Marking order ${order.id} as paid w.r.t. event ${event}`
    )

    return true
  }

  return false
}

/**
 * Updates the availability of the products after a new order
 * or an order cancelation
 *
 * @param {model.Shop} shop
 * @param {Object} shopConfig Shop's decrypted config
 * @param {Object} cartData Cart data
 * @param {Boolean} increment Adds to the quantity instead of decreasing, to be used when cancelling/rejecting
 *
 * @returns {{
 *  success,
 *  error
 * }}
 */
async function updateInventoryData(
  shop,
  shopConfig,
  cartData,
  increment = false
) {
  // Nothing to do if inventory management is not enabled for the shop.
  if (!shopConfig.inventory) {
    return { success: true }
  }

  const quantModifier = increment ? 1 : -1

  const cartItems = get(cartData, 'items', [])
  const nonExternalItems = cartItems.filter((item) => !item.externalVariantId)
  const dbProducts = await Product.findAll({
    where: {
      shopId: shop.id,
      productId: cartItems.map((item) => item.product)
    }
  })

  const allValidProducts = nonExternalItems.every(
    (item) => !!dbProducts.find((product) => product.productId === item.product)
  )

  if (!allValidProducts) {
    log.error(`[Shop ${shop.id}] Invalid product ID`, cartItems)
    return {
      error: 'Some products in this order are unavailable'
    }
  }

  for (const product of dbProducts) {
    const allItems = cartItems.filter(
      (item) => item.product === product.productId
    )
    for (const item of allItems) {
      const variantId = get(item, 'variant')

      if (variantId == null) {
        log.error(
          `[Shop ${shop.id}] Invalid variant ID`,
          product.productId,
          variantId
        )
        return {
          error: 'Some products in this order are unavailable'
        }
      }

      const quant = quantModifier * item.quantity
      const productStock = product.stockLeft + quant
      const currentVariantStock = product.variantsStock[variantId]
      let variantStock =
        typeof currentVariantStock === 'number'
          ? currentVariantStock + quant
          : productStock

      let notEnoughStock = productStock < 0 || variantStock < 0
      if (item.externalProductId) {
        if (product.stockLeft === -1) {
          // -1 === Unlimited stock
          continue
        }
        // For printful items, only look at product stock, not variant stock
        notEnoughStock = productStock < 0
        variantStock = 0
      }

      if (!increment && notEnoughStock) {
        log.error(
          `[Shop ${shop.id}] Product has insufficient stock`,
          product.productId,
          variantId
        )
        return {
          error: 'Some products in this order are out of stock'
        }
      }

      log.debug(
        `Updating stock of product ${product.productId} to ${productStock} and variant ${variantId} to ${variantStock}`
      )

      await product.update({
        stockLeft: productStock,
        variantsStock: {
          ...product.variantsStock,
          [variantId]: variantStock
        }
      })
    }
  }

  log.info(`Updated inventory.`)

  return {
    success: true
  }
}

module.exports = {
  createOrderId,
  getShortOrderId,
  processNewOrder,
  processDeferredPayment,
  isValidTransition,
  updatePaymentStatus
}
