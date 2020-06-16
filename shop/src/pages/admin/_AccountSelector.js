import React, { useState } from 'react'
import { useHistory } from 'react-router-dom'
import get from 'lodash/get'

import { useStateValue } from 'data/state'
import useConfig from 'utils/useConfig'

import Caret from 'components/icons/Caret'
import Popover from 'components/Popover'

const ShopsDropdown = () => {
  const [shouldClose, setShouldClose] = useState(0)
  const { config, setDataSrc } = useConfig()
  const [{ admin }, dispatch] = useStateValue()
  const history = useHistory()

  const shops = get(admin, 'shops', [])
  return (
    <Popover
      el="div"
      placement="bottom-start"
      className="shop-title"
      contentClassName="shops-dropdown"
      shouldClose={shouldClose}
      button={
        <>
          {config.logo ? (
            <img src={`${config.dataSrc}${config.logo}`} />
          ) : (
            config.title
          )}
          <Caret />
        </>
      }
    >
      <>
        {shops.map((shop) => (
          <div
            className={`shop-el${
              shop.authToken === config.activeShop ? ' selected' : ''
            }`}
            key={shop.id}
            onClick={() => {
              if (localStorage.activeShop === shop.authToken) return
              localStorage.activeShop = shop.authToken
              setDataSrc(`${shop.authToken}/`)
              dispatch({ type: 'reset', dataDir: shop.authToken })
              history.push({
                pathname: `/admin`,
                state: { scrollToTop: true }
              })
              setShouldClose(shouldClose + 1)
            }}
          >
            <img src="/images/green-checkmark.svg" />
            {shop.name}
          </div>
        ))}
        <div className="new-shop-link">
          <div className="add-shop-icon">+</div>
          Add a shop
        </div>
      </>
    </Popover>
  )
}

export default ShopsDropdown

require('react-styl')(`
  .shop-title
    .icon.icon-caret
      fill: #3b80ee
      margin-left: 0.75rem

  .shops-dropdown
    position: absolute
    z-index: 1
    min-width: 250px
    border-radius: 10px
    box-shadow: 0 2px 11px 0 rgba(0, 0, 0, 0.2)
    border: solid 1px #cdd7e0
    background-color: #ffffff

    padding: 1.5rem

    .new-shop-link
      display: flex
      align-items: center
      font-size: 0.75rem
      color: #3b80ee
      &:not(:first-child)
        border-top: 1px solid #cdd7e0
        padding-top: 1rem
        margin-top: 1rem
      .add-shop-icon
        border: solid 1px #3b80ee
        border-radius: 50%
        height: 18px
        width: 18px
        display: flex
        align-items: center
        justify-content: center
        margin-right: 5px

    .shop-el
      display: flex
      align-items: center
      font-size: 1rem
      cursor: pointer
      &:not(:last-child)
        margin-bottom: 1rem
      img
        height: 14px
        width: 14px
        object-fit: contain
        margin-right: 10px
      &:not(.selected) img
        visibility: hidden
`)