(function () {
  function ready(fn) {
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn();
  }

  function text(el) {
    return (el && el.textContent ? el.textContent : '').trim();
  }

  function findCardByTitle(title) {
    return Array.prototype.slice.call(document.querySelectorAll('section.card')).find(function (card) {
      var h = card.querySelector('h2');
      return h && text(h) === title;
    });
  }

  function htmlEscape(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildRestaurantMeta(restaurantCard) {
    var rows = Array.prototype.slice.call(restaurantCard.querySelectorAll('form.restaurant-row'));
    return rows.map(function (form) {
      var hidden = form.querySelector('input[name="source_id"]');
      var sourceId = hidden ? hidden.value : '';
      var info = form.querySelector('div');
      var name = info && info.querySelector('strong') ? text(info.querySelector('strong')) : sourceId;
      var typeText = info && info.querySelector('small') ? text(info.querySelector('small')) : sourceId;
      var select = form.querySelector('select[name="source_location"]');
      var selected = select && select.options[select.selectedIndex] ? text(select.options[select.selectedIndex]) : 'Praca';
      return { form: form, sourceId: sourceId, name: name, typeText: typeText, location: selected, select: select };
    });
  }

  function compactRestaurantTable(restaurantCard, meta) {
    if (!restaurantCard || restaurantCard.classList.contains('compact-restaurants-card')) return;
    restaurantCard.classList.add('compact-restaurants-card');
    var p = restaurantCard.querySelector('p.muted');
    if (p) p.textContent = 'Správa lokalít pre reštaurácie. Klikni na ceruzku, zmeň lokalitu a ulož.';
    var table = document.createElement('div');
    table.className = 'restaurants-table';
    table.innerHTML = '<div class="restaurants-table-header"><div>Názov</div><div>Typ</div><div>Lokalita</div><div></div></div>';

    meta.forEach(function (row) {
      var form = row.form;
      var hidden = form.querySelector('input[name="source_id"]');
      var oldButton = form.querySelector('button');
      var select = row.select;

      form.className = 'compact-restaurant-row';
      form.innerHTML = '';
      if (hidden) form.appendChild(hidden);

      var c1 = document.createElement('div');
      c1.className = 'compact-restaurant-name';
      c1.innerHTML = '<strong></strong>';
      c1.querySelector('strong').textContent = row.name;

      var c2 = document.createElement('div');
      c2.className = 'compact-restaurant-type';
      c2.textContent = row.typeText;

      var c3 = document.createElement('div');
      c3.className = 'compact-restaurant-location';
      var badge = document.createElement('span');
      badge.className = 'location-badge';
      badge.textContent = row.location;
      c3.appendChild(badge);
      if (select) c3.appendChild(select);

      var c4 = document.createElement('div');
      c4.className = 'compact-restaurant-action';
      var button = oldButton || document.createElement('button');
      button.type = 'button';
      button.className = 'restaurant-edit-button';
      button.textContent = '✏️';
      button.title = 'Zmeniť lokalitu';
      button.setAttribute('aria-label', 'Zmeniť lokalitu pre ' + row.name);
      button.addEventListener('click', function () {
        if (!form.classList.contains('is-editing')) {
          form.classList.add('is-editing');
          button.type = 'submit';
          button.textContent = '💾';
          button.title = 'Uložiť lokalitu';
          if (select) select.focus();
        }
      });
      c4.appendChild(button);

      form.appendChild(c1);
      form.appendChild(c2);
      form.appendChild(c3);
      form.appendChild(c4);
      table.appendChild(form);
    });

    var oldRows = Array.prototype.slice.call(restaurantCard.querySelectorAll('form.restaurant-row'));
    oldRows.forEach(function (row) { if (row.parentNode === restaurantCard) restaurantCard.removeChild(row); });
    restaurantCard.appendChild(table);
  }

  function buildFilters(toolbarCard, meta, itemSection) {
    if (!toolbarCard || toolbarCard.classList.contains('admin-filters-ready')) return;
    toolbarCard.classList.add('admin-filters-ready');
    var form = toolbarCard.querySelector('form.toolbar');
    if (!form) return;
    form.classList.add('admin-filter-grid');

    var restaurantLabel = document.createElement('label');
    restaurantLabel.textContent = 'Reštaurácia';
    var restaurantSelect = document.createElement('select');
    restaurantSelect.name = 'client_restaurant_filter';
    restaurantSelect.innerHTML = '<option value="">Všetky reštaurácie</option>' + meta.map(function (m) {
      return '<option value="' + htmlEscape(m.name) + '">' + htmlEscape(m.name) + '</option>';
    }).join('');
    restaurantLabel.appendChild(restaurantSelect);

    var locations = Array.from(new Set(meta.map(function (m) { return m.location || 'Praca'; })));
    var locationLabel = document.createElement('label');
    locationLabel.textContent = 'Lokalita';
    var locationSelect = document.createElement('select');
    locationSelect.name = 'client_location_filter';
    locationSelect.innerHTML = '<option value="">Všetky lokality</option>' + locations.map(function (l) {
      return '<option value="' + htmlEscape(l) + '">' + htmlEscape(l) + '</option>';
    }).join('');
    locationLabel.appendChild(locationSelect);

    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear-filters';
    clear.textContent = 'Vymazať filtre';

    form.appendChild(restaurantLabel);
    form.appendChild(locationLabel);
    form.appendChild(clear);

    var locationByName = {};
    meta.forEach(function (m) { locationByName[m.name] = m.location || 'Praca'; });

    function apply() {
      var restaurant = restaurantSelect.value;
      var location = locationSelect.value;
      var items = Array.prototype.slice.call(itemSection.querySelectorAll('details.admin-item'));
      items.forEach(function (item) {
        var source = text(item.querySelector('summary small'));
        var loc = locationByName[source] || '';
        var showRestaurant = !restaurant || source === restaurant;
        var showLocation = !location || loc === location;
        item.style.display = showRestaurant && showLocation ? '' : 'none';
      });
    }

    restaurantSelect.addEventListener('change', apply);
    locationSelect.addEventListener('change', apply);
    clear.addEventListener('click', function () {
      restaurantSelect.value = '';
      locationSelect.value = '';
      apply();
    });
  }

  function uniqueLocations(meta) {
    return Array.from(new Set(meta.map(function (m) { return m.location || 'Praca'; })));
  }

  function buildLocationOrderPanel(meta) {
    var card = document.createElement('section');
    card.className = 'card location-order-card';
    card.innerHTML = '<h2>Poradie lokalít</h2><p class="location-order-note">Nižšie číslo sa zobrazí skôr. Hodnota 1 je prvá lokalita, vyššie čísla sa zobrazia neskôr.</p><div class="location-order-table"><div class="location-order-header"><div>Lokalita</div><div>Váha</div><div>Uložiť</div></div></div><div class="location-order-status" aria-live="polite"></div>';
    var table = card.querySelector('.location-order-table');
    var status = card.querySelector('.location-order-status');

    function setStatus(message, ok) {
      status.textContent = message || '';
      status.className = 'location-order-status ' + (ok ? 'ok' : 'error');
    }

    function renderRows(orderMap) {
      Array.prototype.slice.call(table.querySelectorAll('.location-order-row')).forEach(function (row) { row.remove(); });
      var locations = uniqueLocations(meta).sort(function (a, b) {
        return Number(orderMap[a] || 100) - Number(orderMap[b] || 100) || a.localeCompare(b, 'sk');
      });
      locations.forEach(function (location, index) {
        var weight = Number(orderMap[location] || (index + 1) * 10);
        var row = document.createElement('form');
        row.className = 'location-order-row';
        row.method = 'post';
        row.action = '/admin/location-order/update';
        row.innerHTML = '<div class="location-order-name"><strong>' + htmlEscape(location) + '</strong><span class="location-order-help">Poradie pre celú lokalitu</span></div><div class="location-order-weight"><input type="number" name="display_order" min="1" step="1" value="' + weight + '"></div><div><input type="hidden" name="source_location" value="' + htmlEscape(location) + '"><button class="location-order-save" type="submit" title="Uložiť poradie">💾</button></div>';
        row.addEventListener('submit', function (event) {
          event.preventDefault();
          var body = new URLSearchParams(new FormData(row));
          fetch('/admin/location-order/update', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          }).then(function () {
            setStatus('Poradie lokality ' + location + ' bolo uložené.', true);
          }).catch(function (err) {
            setStatus('Uloženie zlyhalo: ' + err.message, false);
          });
        });
        table.appendChild(row);
      });
    }

    fetch('/location-order.json', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : { order: {} }; })
      .then(function (data) { renderRows(data.order || {}); })
      .catch(function () { renderRows({}); });

    return card;
  }

  function buildTabs() {
    var main = document.querySelector('main.admin-page');
    if (!main || main.classList.contains('admin-tabs-ready')) return;

    var top = main.querySelector('.top');
    var toolbarCard = Array.prototype.slice.call(document.querySelectorAll('section.card')).find(function (card) {
      return !!card.querySelector('form.toolbar');
    });
    var restaurantCard = findCardByTitle('Reštaurácie a lokality');
    var addItemCard = findCardByTitle('Pridať položku');
    var itemSection = Array.prototype.slice.call(document.querySelectorAll('main.admin-page > section')).find(function (section) {
      var h = section.querySelector('h2');
      return h && text(h).indexOf('Položky pre') === 0;
    });

    if (!top || !toolbarCard || !restaurantCard || !addItemCard || !itemSection) return;

    var meta = buildRestaurantMeta(restaurantCard);
    compactRestaurantTable(restaurantCard, meta);
    buildFilters(toolbarCard, meta, itemSection);

    var tabs = document.createElement('div');
    tabs.className = 'admin-tabs';
    tabs.innerHTML = '<button type="button" class="admin-tab-button is-active" data-tab="items">Položky</button><button type="button" class="admin-tab-button" data-tab="locations">Lokality</button><button type="button" class="admin-tab-button" data-tab="location-order">Poradie lokalít</button>';

    var itemsPanel = document.createElement('section');
    itemsPanel.className = 'admin-tab-panel is-active';
    itemsPanel.dataset.panel = 'items';
    var locationsPanel = document.createElement('section');
    locationsPanel.className = 'admin-tab-panel';
    locationsPanel.dataset.panel = 'locations';
    var locationOrderPanel = document.createElement('section');
    locationOrderPanel.className = 'admin-tab-panel';
    locationOrderPanel.dataset.panel = 'location-order';

    top.insertAdjacentElement('afterend', tabs);
    tabs.insertAdjacentElement('afterend', locationOrderPanel);
    tabs.insertAdjacentElement('afterend', locationsPanel);
    tabs.insertAdjacentElement('afterend', itemsPanel);

    itemsPanel.appendChild(toolbarCard);
    itemsPanel.appendChild(addItemCard);
    itemsPanel.appendChild(itemSection);
    locationsPanel.appendChild(restaurantCard);
    locationOrderPanel.appendChild(buildLocationOrderPanel(meta));

    function show(tab) {
      Array.prototype.slice.call(tabs.querySelectorAll('.admin-tab-button')).forEach(function (button) {
        button.classList.toggle('is-active', button.dataset.tab === tab);
      });
      itemsPanel.classList.toggle('is-active', tab === 'items');
      locationsPanel.classList.toggle('is-active', tab === 'locations');
      locationOrderPanel.classList.toggle('is-active', tab === 'location-order');
      var hash = tab === 'locations' ? '#lokality' : (tab === 'location-order' ? '#poradie-lokalit' : '#polozky');
      history.replaceState(null, '', hash);
    }

    tabs.addEventListener('click', function (event) {
      var button = event.target.closest('.admin-tab-button');
      if (button) show(button.dataset.tab);
    });

    if (window.location.hash === '#lokality') show('locations');
    if (window.location.hash === '#poradie-lokalit') show('location-order');
    main.classList.add('admin-tabs-ready');
  }

  ready(buildTabs);
})();
