'use strict';

document.addEventListener('DOMContentLoaded', () => {
    const apiBaseUrl = location.hostname.endsWith('.supabase.co')
        ? '/functions/v1/sogo'
        : location.hostname === 'ido-sogo.github.io'
            ? 'https://ppwyjyfuexndkekmhfwn.supabase.co/functions/v1/sogo'
            : '';
    const state = {
        config: null,
        user: null,
        events: [],
        updates: [],
        outings: [],
        members: [],
        selectedDate: null,
        displayedMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    };

    const authView = document.getElementById('auth-view');
    const appView = document.getElementById('app-view');
    const authStatus = document.getElementById('auth-status');
    const loginTab = document.getElementById('login-tab');
    const registerTab = document.getElementById('register-tab');
    const loginForm = document.getElementById('login-panel');
    const registerForm = document.getElementById('register-panel');
    const registerRole = document.getElementById('register-role');
    const registerGroup = document.getElementById('register-group');
    const staffPassword = document.getElementById('staff-password');
    const staffPasswordField = document.getElementById('staff-password-field');
    const registerGroupField = document.getElementById('register-group-field');
    const userBadge = document.getElementById('user-badge');
    const calendarGrid = document.getElementById('calendar-grid');
    const monthLabel = document.getElementById('month-label');
    const calendarStatus = document.getElementById('calendar-status');
    const activityStatus = document.getElementById('activity-status');
    const activityList = document.getElementById('activity-list');
    const outingList = document.getElementById('outing-list');
    const adminEventList = document.getElementById('admin-event-list');
    const staffUpdateList = document.getElementById('staff-update-list');
    const adminGroupList = document.getElementById('admin-group-list');
    const adminUserList = document.getElementById('admin-user-list');
    const dayDialog = document.getElementById('day-dialog');
    const dayEventList = document.getElementById('day-event-list');
    const dialogStatus = document.getElementById('dialog-status');
    const calendarItemEditDialog = document.getElementById('calendar-item-edit-dialog');
    const calendarItemEditForm = document.getElementById('calendar-item-edit-form');
    const outingEditDialog = document.getElementById('outing-edit-dialog');
    const outingEditForm = document.getElementById('outing-edit-form');
    const outingFormSection = document.getElementById('outing-form-section');
    const outingForm = document.getElementById('outing-form');
    const outingDate = document.getElementById('outing-date');
    const outingGroupLabel = document.getElementById('outing-group');
    const today = new Date();
    const todayString = toDateString(today);

    loginTab.addEventListener('click', () => setAuthTab('login'));
    registerTab.addEventListener('click', () => setAuthTab('register'));
    registerRole.addEventListener('change', updateRegistrationFields);
    document.getElementById('close-day-dialog').addEventListener('click', () => dayDialog.close());
    document.getElementById('close-calendar-item-edit').addEventListener(
        'click',
        () => calendarItemEditDialog.close()
    );
    document.getElementById('cancel-calendar-item-edit').addEventListener(
        'click',
        () => calendarItemEditDialog.close()
    );
    document.getElementById('close-outing-edit').addEventListener('click', () => outingEditDialog.close());
    document.getElementById('cancel-outing-edit').addEventListener('click', () => outingEditDialog.close());
    document.getElementById('logout-button').addEventListener('click', logout);
    document.getElementById('home-link').addEventListener('click', (event) => {
        event.preventDefault();
        showView('calendar-page');
    });

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(loginForm);
        try {
            const result = await request('/api/auth/login', 'POST', {
                username: formData.get('username'),
                password: formData.get('password')
            });
            await enterApp(result.user);
        } catch (error) {
            showStatus(authStatus, error.message, true);
        }
    });

    registerForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(registerForm);
        try {
            const result = await request('/api/auth/register', 'POST', {
                username: formData.get('username'),
                password: formData.get('password'),
                role: formData.get('role'),
                group: formData.get('group'),
                staffPassword: formData.get('staffPassword')
            });
            await enterApp(result.user);
        } catch (error) {
            showStatus(authStatus, error.message, true);
        }
    });

    document.querySelectorAll('.nav-button[data-view]').forEach((button) => {
        button.addEventListener('click', () => showView(button.dataset.view));
    });
    document.querySelectorAll('[data-month-step]').forEach((button) => {
        button.addEventListener('click', () => {
            state.displayedMonth = new Date(
                state.displayedMonth.getFullYear(),
                state.displayedMonth.getMonth() + Number(button.dataset.monthStep),
                1
            );
            renderCalendar();
        });
    });
    document.getElementById('today-button').addEventListener('click', () => {
        state.displayedMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        renderCalendar();
    });
    document.getElementById('print-calendar-button').addEventListener('click', () => window.print());

    calendarGrid.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) {
            return;
        }
        const dayButton = event.target.closest('button[data-date]');
        if (!dayButton) {
            return;
        }
        state.selectedDate = dayButton.dataset.date;
        renderCalendar();
        renderDayDialog(state.selectedDate);
        dayDialog.showModal();
    });

    dayEventList.addEventListener('submit', async (event) => {
        if (!(event.target instanceof HTMLFormElement)
            || !event.target.matches('.completion-form')) {
            return;
        }
        event.preventDefault();
        const formData = new FormData(event.target);
        const eventId = event.target.dataset.eventId;
        try {
            await request(`/api/calendar-items/${eventId}/completion`, 'POST', {
                message: formData.get('message')
            });
            await refreshData();
            renderDayDialog(state.selectedDate);
            showStatus(dialogStatus, '完了報告を投稿しました。');
        } catch (error) {
            showStatus(dialogStatus, error.message, true);
        }
    });

    dayEventList.addEventListener('click', async (event) => {
        if (!(event.target instanceof Element)) {
            return;
        }
        const editButton = event.target.closest('button[data-edit-outing-id]');
        if (editButton) {
            openOutingEdit(Number(editButton.dataset.editOutingId));
            return;
        }
        const button = event.target.closest('button[data-outing-id]');
        if (!button) {
            return;
        }
        try {
            await request(`/api/outings/${button.dataset.outingId}`, 'DELETE');
            await refreshData();
            renderDayDialog(state.selectedDate);
            showStatus(dialogStatus, '外出予定を削除しました。');
        } catch (error) {
            showStatus(dialogStatus, error.message, true);
        }
    });

    outingList.addEventListener('click', async (event) => {
        if (!(event.target instanceof Element)) {
            return;
        }
        const editButton = event.target.closest('button[data-edit-outing-id]');
        if (editButton) {
            openOutingEdit(Number(editButton.dataset.editOutingId));
            return;
        }
        const button = event.target.closest('button[data-outing-id]');
        if (!button) {
            return;
        }
        try {
            await request(`/api/outings/${button.dataset.outingId}`, 'DELETE');
            await refreshData();
            showStatus(activityStatus, '外出予定を削除しました。');
        } catch (error) {
            showStatus(activityStatus, error.message, true);
        }
    });

    calendarItemEditForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(calendarItemEditForm);
        const itemId = formData.get('itemId');
        try {
            await request(`/api/calendar-items/${itemId}`, 'PATCH', {
                date: formData.get('date'),
                groupName: calendarItemEditForm.dataset.itemType === 'deadline'
                    ? formData.get('groupName')
                    : null,
                title: formData.get('title')
            });
            calendarItemEditDialog.close();
            await refreshData();
            showStatus(document.getElementById('admin-status'), '予定を変更しました。');
        } catch (error) {
            showStatus(document.getElementById('calendar-item-edit-status'), error.message, true);
        }
    });

    outingEditForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(outingEditForm);
        const outingId = formData.get('outingId');
        try {
            await request(`/api/outings/${outingId}`, 'PATCH', {
                date: formData.get('date'),
                description: formData.get('description')
            });
            const returnToDayDialog = dayDialog.open;
            outingEditDialog.close();
            await refreshData();
            if (returnToDayDialog) {
                renderDayDialog(state.selectedDate);
            }
            showStatus(
                returnToDayDialog ? dialogStatus : activityStatus,
                '外出予定を変更しました。'
            );
        } catch (error) {
            showStatus(document.getElementById('outing-edit-status'), error.message, true);
        }
    });

    outingForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(outingForm);
        try {
            await request('/api/outings', 'POST', {
                date: formData.get('date'),
                description: formData.get('description')
            });
            outingForm.reset();
            outingDate.value = state.selectedDate;
            await refreshData();
            renderDayDialog(state.selectedDate);
            showStatus(dialogStatus, '外出予定を登録しました。');
        } catch (error) {
            showStatus(dialogStatus, error.message, true);
        }
    });

    document.getElementById('outing-day-admin-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        try {
            await request('/api/calendar-items', 'POST', {
                type: 'outing_day',
                date: formData.get('date'),
                title: formData.get('title')
            });
            event.target.reset();
            document.getElementById('outing-day-date').min = todayString;
            showStatus(document.getElementById('admin-status'), '外出可能日を登録しました。');
            await refreshData();
        } catch (error) {
            showStatus(document.getElementById('admin-status'), error.message, true);
        }
    });

    document.getElementById('deadline-admin-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        try {
            await request('/api/calendar-items', 'POST', {
                type: 'deadline',
                date: formData.get('date'),
                groupName: formData.get('groupName'),
                title: formData.get('title')
            });
            event.target.reset();
            document.getElementById('deadline-date').min = todayString;
            showStatus(document.getElementById('admin-status'), '提出期限を登録しました。');
            await refreshData();
        } catch (error) {
            showStatus(document.getElementById('admin-status'), error.message, true);
        }
    });

    document.getElementById('group-admin-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        try {
            await request('/api/groups', 'POST', { name: formData.get('name') });
            event.target.reset();
            await refreshGroupOptions();
            await refreshData();
            showStatus(document.getElementById('admin-status'), 'グループを追加しました。');
        } catch (error) {
            showStatus(document.getElementById('admin-status'), error.message, true);
        }
    });

    adminGroupList.addEventListener('click', async (event) => {
        if (!(event.target instanceof Element)) {
            return;
        }
        const button = event.target.closest('button[data-delete-group]');
        if (!button) {
            return;
        }
        const groupName = button.dataset.deleteGroup;
        const moveTo = button.parentElement.querySelector('.group-move-select').value;
        if (!window.confirm(
            `${groupName}の利用者・提出期限・完了報告・外出予定を「${moveTo}」へ移して、グループを削除します。続けますか？`
        )) {
            return;
        }
        try {
            await request('/api/groups', 'DELETE', { name: groupName, moveTo });
            await refreshGroupOptions();
            await refreshData();
            showStatus(document.getElementById('admin-status'), `${groupName}を${moveTo}へ移して削除しました。`);
        } catch (error) {
            showStatus(document.getElementById('admin-status'), error.message, true);
        }
    });

    adminUserList.addEventListener('submit', async (event) => {
        if (!(event.target instanceof HTMLFormElement)
            || !event.target.matches('.assignment-form')) {
            return;
        }
        event.preventDefault();
        const form = event.target;
        const formData = new FormData(form);
        try {
            await request(`/api/users/${form.dataset.userId}/group`, 'PATCH', {
                groupName: formData.get('groupName')
            });
            await refreshData();
            showStatus(document.getElementById('admin-status'), '所属グループを更新しました。');
        } catch (error) {
            showStatus(document.getElementById('admin-status'), error.message, true);
        }
    });

    adminEventList.addEventListener('click', async (event) => {
        if (!(event.target instanceof Element)) {
            return;
        }
        const editButton = event.target.closest('button[data-edit-item-id]');
        if (editButton) {
            openCalendarItemEdit(Number(editButton.dataset.editItemId));
            return;
        }
        const button = event.target.closest('button[data-item-id]');
        if (!button) {
            return;
        }
        try {
            await request(`/api/calendar-items/${button.dataset.itemId}`, 'DELETE');
            showStatus(document.getElementById('admin-status'), '予定を削除しました。');
            await refreshData();
        } catch (error) {
            showStatus(document.getElementById('admin-status'), error.message, true);
        }
    });

    initialize().catch((error) => {
        showStatus(authStatus, error.message, true);
    });

    async function initialize() {
        const config = await request('/api/config');
        state.config = config;
        populateGroupSelect(registerGroup, config.groups);
        populateGroupSelect(document.getElementById('deadline-group'), config.groups);
        populateGroupSelect(document.getElementById('calendar-item-edit-group'), config.groups);
        const databaseConfigured = config.databaseConfigured;
        document.getElementById('database-setup-notice').hidden = databaseConfigured;
        document.querySelectorAll('.auth-form button[type="submit"]')
            .forEach((button) => { button.disabled = !databaseConfigured; });
        registerRole.querySelector('option[value="staff"]').disabled = !config.staffRegistrationEnabled;
        document.getElementById('staff-setup-notice').hidden =
            !databaseConfigured || config.staffRegistrationEnabled;
        document.getElementById('staff-password-field').hidden = true;
        document.getElementById('admin-nav').hidden = true;

        if (!databaseConfigured) {
            return;
        }

        try {
            const result = await request('/api/me');
            await enterApp(result.user);
        } catch (error) {
            if (error.status !== 401) {
                throw error;
            }
        }
    }

    async function enterApp(user) {
        state.user = user;
        authView.hidden = true;
        appView.hidden = false;
        document.getElementById('admin-nav').hidden = user.role !== 'staff';
        userBadge.textContent = user.role === 'staff'
            ? `${user.username} ・ 総合係`
            : `${user.username} ・ ${user.group}`;
        document.getElementById('activity-description').textContent = user.role === 'staff'
            ? 'すべてのグループの提出状況と外出予定を確認できます。'
            : `${user.group}の提出期限・完了報告と外出予定を確認できます。`;
        for (const id of ['outing-day-date', 'deadline-date']) {
            document.getElementById(id).min = todayString;
        }
        await refreshData();
        showView('calendar-page');
    }

    async function logout() {
        try {
            await request('/api/auth/logout', 'POST', {});
        } catch (error) {
            showStatus(authStatus, error.message, true);
        }
        state.user = null;
        appView.hidden = true;
        authView.hidden = false;
        loginForm.reset();
        registerForm.reset();
        setAuthTab('login');
    }

    async function refreshData() {
        const requests = [request('/api/calendar')];
        if (state.user.role === 'staff') {
            requests.push(request('/api/admin/users'));
        }
        const [result, adminResult] = await Promise.all(requests);
        state.events = result.events;
        state.updates = result.updates;
        state.outings = result.outings;
        state.members = adminResult ? adminResult.users : [];
        renderCalendar();
        renderActivity();
        if (state.user.role === 'staff') {
            renderAdmin();
        }
    }

    function renderCalendar() {
        const year = state.displayedMonth.getFullYear();
        const month = state.displayedMonth.getMonth();
        const firstWeekday = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
        monthLabel.textContent = new Intl.DateTimeFormat('ja-JP', {
            year: 'numeric',
            month: 'long'
        }).format(state.displayedMonth);
        calendarGrid.replaceChildren();

        for (let cell = 0; cell < cellCount; cell += 1) {
            const day = cell - firstWeekday + 1;
            if (day < 1 || day > daysInMonth) {
                const blank = document.createElement('div');
                blank.className = 'calendar-empty';
                blank.setAttribute('role', 'gridcell');
                blank.setAttribute('aria-hidden', 'true');
                calendarGrid.append(blank);
                continue;
            }
            const date = toDateString(new Date(year, month, day));
            const events = eventsForDate(date);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'calendar-day';
            button.dataset.date = date;
            button.setAttribute('role', 'gridcell');
            button.setAttribute('aria-label', `${formatDate(date)}、予定${events.length}件`);
            button.setAttribute('aria-pressed', String(date === state.selectedDate));
            if (date === todayString) {
                button.classList.add('is-today');
                button.setAttribute('aria-current', 'date');
            }
            if (date === state.selectedDate) {
                button.classList.add('selected');
            }

            const number = document.createElement('span');
            number.className = 'date-number';
            number.textContent = String(day);
            button.append(number);

            if (events.length > 0) {
                const markers = document.createElement('span');
                markers.className = 'calendar-event-markers';
                for (const [index, item] of events.entries()) {
                    const marker = document.createElement('span');
                    marker.className = `calendar-event ${eventClass(item)}${index >= 2 ? ' calendar-event-print-only' : ''}`;
                    marker.textContent = calendarEventTitle(item);
                    markers.append(marker);
                }
                if (events.length > 2) {
                    const more = document.createElement('span');
                    more.className = 'more-events';
                    more.textContent = `+${events.length - 2}件`;
                    markers.append(more);
                }
                button.append(markers);
            }
            calendarGrid.append(button);
        }
    }

    function eventsForDate(date) {
        const calendarItems = state.events
            .filter((item) => item.date === date)
            .map((item) => ({ ...item, category: 'calendar' }));
        const outings = state.outings
            .filter((outing) => outing.date === date)
            .map((outing) => ({ ...outing, type: 'outing', category: 'outing' }));
        return [...calendarItems, ...outings];
    }

    function renderDayDialog(date) {
        document.getElementById('dialog-date').textContent = formatDate(date);
        showStatus(dialogStatus, '');
        dayEventList.replaceChildren();
        const items = eventsForDate(date);
        const isOutingDay = state.events.some((item) => item.date === date && item.type === 'outing_day');

        if (items.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'dialog-empty';
            empty.textContent = 'この日の予定はありません。';
            dayEventList.append(empty);
        }

        for (const item of items) {
            const listItem = document.createElement('li');
            listItem.className = 'dialog-event';
            const title = document.createElement('h3');
            title.className = 'dialog-event-title';
            title.textContent = calendarEventTitle(item);
            listItem.append(title);

            if (item.type === 'deadline') {
                const meta = document.createElement('p');
                meta.className = 'dialog-event-meta';
                meta.textContent = `提出期限 ・ ${item.groupName}`;
                listItem.append(meta);
                renderCompletionUpdates(listItem, item);
                if (state.user.role === 'member' && item.groupName === state.user.group) {
                    listItem.append(createCompletionForm(item));
                }
            } else if (item.type === 'outing_day') {
                const meta = document.createElement('p');
                meta.className = 'dialog-event-meta';
                meta.textContent = '総合係が設定した外出可能日';
                listItem.append(meta);
            } else {
                const meta = document.createElement('p');
                meta.className = 'dialog-event-meta';
                meta.textContent = `外出予定 ・ ${item.groupName} ・ ${item.username}`;
                listItem.append(meta);
                const description = document.createElement('p');
                description.className = 'activity-note';
                description.textContent = item.description;
                listItem.append(description);
                const actions = document.createElement('div');
                actions.className = 'activity-actions';
                if (state.user.role === 'staff') {
                    const edit = document.createElement('button');
                    edit.type = 'button';
                    edit.className = 'inline-button';
                    edit.dataset.editOutingId = String(item.id);
                    edit.textContent = '変更';
                    actions.append(edit);
                }
                if (canDeleteOuting(item)) {
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'delete-button';
                    remove.dataset.outingId = String(item.id);
                    remove.textContent = '外出予定を削除';
                    actions.append(remove);
                }
                if (actions.childElementCount > 0) {
                    listItem.append(actions);
                }
            }
            dayEventList.append(listItem);
        }

        outingFormSection.hidden = state.user.role !== 'member' || !isOutingDay;
        outingDate.value = date;
        outingGroupLabel.textContent = state.user.group || '';
        outingForm.reset();
        outingDate.value = date;
    }

    function renderCompletionUpdates(container, deadline) {
        const updates = state.updates.filter((update) => update.eventId === deadline.id);
        for (const update of updates) {
            const message = document.createElement('p');
            message.className = 'activity-note';
            message.textContent = `完了報告 ・ ${update.username}: ${update.message}`;
            container.append(message);
        }
    }

    function createCompletionForm(deadline) {
        const existing = state.updates.find(
            (update) => update.eventId === deadline.id && update.userId === state.user.id
        );
        const form = document.createElement('form');
        form.className = 'completion-form';
        form.dataset.eventId = String(deadline.id);
        const input = document.createElement('textarea');
        input.name = 'message';
        input.maxLength = 300;
        input.placeholder = '例：提出しました';
        input.value = existing ? existing.message : '';
        input.setAttribute('aria-label', `${deadline.title}の完了報告`);
        const button = document.createElement('button');
        button.type = 'submit';
        button.className = 'primary-button';
        button.textContent = existing ? '報告を更新' : '完了を報告';
        form.append(input, button);
        return form;
    }

    function renderActivity() {
        const deadlines = state.events.filter((item) => item.type === 'deadline');
        renderEmptyOrList(activityList, deadlines, (item) => {
            const updates = state.updates.filter((update) => update.eventId === item.id);
            const card = createActivityCard(
                item,
                `提出期限 ・ ${item.groupName}`,
                'カレンダーで日付を選ぶと、完了報告を投稿できます。'
            );
            for (const update of updates) {
                appendText(card, `完了報告 ・ ${update.username}: ${update.message}`);
            }
            return card;
        }, '提出期限はまだ登録されていません。');

        renderEmptyOrList(outingList, state.outings, (outing) => {
            const card = document.createElement('li');
            card.className = 'activity-item';
            const header = document.createElement('div');
            header.className = 'activity-item-header';
            const details = document.createElement('div');
            const meta = document.createElement('span');
            meta.className = 'activity-meta';
            meta.textContent = `${formatDate(outing.date)} ・ ${outing.groupName} ・ ${outing.username}`;
            const description = document.createElement('p');
            description.className = 'activity-title';
            description.textContent = outing.description;
            details.append(meta, description);
            header.append(details);
            const actions = document.createElement('div');
            actions.className = 'activity-actions';
            if (state.user.role === 'staff') {
                const edit = document.createElement('button');
                edit.type = 'button';
                edit.className = 'inline-button';
                edit.dataset.editOutingId = String(outing.id);
                edit.textContent = '変更';
                actions.append(edit);
            }
            if (canDeleteOuting(outing)) {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'delete-button';
                remove.dataset.outingId = String(outing.id);
                remove.textContent = '削除';
                actions.append(remove);
            }
            if (actions.childElementCount > 0) {
                header.append(actions);
            }
            card.append(header);
            return card;
        }, '外出予定はまだありません。');
    }

    function renderAdmin() {
        renderEmptyOrList(adminGroupList, state.config.groups, (groupName) => {
            const item = document.createElement('li');
            item.className = 'activity-item group-management-item';
            const name = document.createElement('span');
            name.className = 'activity-title';
            name.textContent = groupName;
            const count = document.createElement('span');
            count.className = 'activity-meta';
            const memberCount = state.members.filter((member) => member.group === groupName).length;
            count.textContent = `${memberCount}名`;
            const details = document.createElement('div');
            details.append(name, count);
            item.append(details);
            if (state.config.groups.length > 1) {
                const actions = document.createElement('div');
                actions.className = 'group-management-actions';
                const select = document.createElement('select');
                select.className = 'group-move-select';
                select.setAttribute('aria-label', `${groupName}の移動先`);
                for (const targetName of state.config.groups) {
                    if (targetName === groupName) {
                        continue;
                    }
                    const option = document.createElement('option');
                    option.value = targetName;
                    option.textContent = targetName;
                    select.append(option);
                }
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'delete-button';
                remove.dataset.deleteGroup = groupName;
                remove.textContent = '移して削除';
                actions.append(select, remove);
                item.append(actions);
            }
            return item;
        }, 'グループはまだありません。');

        renderEmptyOrList(adminUserList, state.members, (member) => {
            const item = document.createElement('li');
            item.className = 'activity-item';
            const form = document.createElement('form');
            form.className = 'assignment-form';
            form.dataset.userId = String(member.id);
            const identity = document.createElement('div');
            const username = document.createElement('p');
            username.className = 'activity-title';
            username.textContent = member.username;
            const currentGroup = document.createElement('span');
            currentGroup.className = 'activity-meta';
            currentGroup.textContent = `現在：${member.group}`;
            identity.append(username, currentGroup);

            const select = document.createElement('select');
            select.name = 'groupName';
            select.setAttribute('aria-label', `${member.username}の所属グループ`);
            for (const groupName of state.config.groups) {
                const option = document.createElement('option');
                option.value = groupName;
                option.textContent = groupName;
                option.selected = groupName === member.group;
                select.append(option);
            }
            const button = document.createElement('button');
            button.type = 'submit';
            button.className = 'secondary-button';
            button.textContent = '所属を変更';
            form.append(identity, select, button);
            item.append(form);
            return item;
        }, '登録済みの一般利用者はいません。');

        renderEmptyOrList(adminEventList, state.events, (item) => {
            const card = createActivityCard(item, eventMeta(item), '');
            const actions = document.createElement('div');
            actions.className = 'activity-actions';
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'inline-button';
            edit.dataset.editItemId = String(item.id);
            edit.textContent = '変更';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'delete-button';
            remove.dataset.itemId = String(item.id);
            remove.textContent = '削除';
            actions.append(edit, remove);
            card.append(actions);
            return card;
        }, '予定はまだ設定されていません。');

        renderEmptyOrList(staffUpdateList, state.updates, (update) => {
            const item = state.events.find((event) => event.id === update.eventId);
            const card = document.createElement('li');
            card.className = 'activity-item';
            const meta = document.createElement('span');
            meta.className = 'activity-meta';
            meta.textContent = `${update.groupName} ・ ${update.username}${item ? ` ・ ${item.title}` : ''}`;
            const message = document.createElement('p');
            message.className = 'activity-title';
            message.textContent = update.message;
            card.append(meta, message);
            return card;
        }, '完了報告はまだありません。');
    }

    function createActivityCard(item, metaText, noteText) {
        const card = document.createElement('li');
        card.className = 'activity-item';
        const header = document.createElement('div');
        header.className = 'activity-item-header';
        const details = document.createElement('div');
        const meta = document.createElement('span');
        meta.className = 'activity-meta';
        meta.textContent = `${formatDate(item.date)} ・ ${metaText}`;
        const title = document.createElement('p');
        title.className = 'activity-title';
        title.textContent = item.title;
        details.append(meta, title);
        header.append(details);
        card.append(header);
        if (noteText) {
            appendText(card, noteText);
        }
        return card;
    }

    function appendText(container, value) {
        const note = document.createElement('p');
        note.className = 'activity-note';
        note.textContent = value;
        container.append(note);
    }

    function renderEmptyOrList(list, items, renderItem, emptyMessage) {
        list.replaceChildren();
        if (items.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'empty-state';
            empty.textContent = emptyMessage;
            list.append(empty);
            return;
        }
        for (const item of items) {
            list.append(renderItem(item));
        }
    }

    function eventMeta(item) {
        return item.type === 'outing_day'
            ? '外出可能日'
            : `提出期限 ・ ${item.groupName}`;
    }

    function calendarEventTitle(item) {
        if (item.type === 'deadline') {
            return `${item.groupName} ${item.title}`;
        }
        if (item.type === 'outing') {
            return `${item.groupName} 外出`;
        }
        return item.title;
    }

    function eventClass(item) {
        if (item.type === 'deadline') {
            return 'deadline';
        }
        if (item.type === 'outing') {
            return 'outing';
        }
        return '';
    }

    function showView(viewId) {
        if (viewId === 'admin-page' && state.user.role !== 'staff') {
            return;
        }
        for (const id of ['calendar-page', 'activity-page', 'admin-page']) {
            document.getElementById(id).hidden = id !== viewId;
        }
        document.querySelectorAll('.nav-button[data-view]').forEach((button) => {
            const active = button.dataset.view === viewId;
            button.classList.toggle('active', active);
            if (active) {
                button.setAttribute('aria-current', 'page');
            } else {
                button.removeAttribute('aria-current');
            }
        });
        window.scrollTo(0, 0);
    }

    function setAuthTab(mode) {
        const registering = mode === 'register';
        loginTab.classList.toggle('active', !registering);
        registerTab.classList.toggle('active', registering);
        loginTab.setAttribute('aria-selected', String(!registering));
        registerTab.setAttribute('aria-selected', String(registering));
        loginForm.hidden = registering;
        registerForm.hidden = !registering;
        showStatus(authStatus, '');
    }

    function updateRegistrationFields() {
        const isStaff = registerRole.value === 'staff';
        registerGroupField.hidden = isStaff;
        registerGroup.required = !isStaff;
        staffPasswordField.hidden = !isStaff;
        staffPassword.required = isStaff;
    }

    function populateGroupSelect(select, groupNames) {
        while (select.options.length > 1) {
            select.remove(1);
        }
        for (const group of groupNames) {
            const option = document.createElement('option');
            option.value = group;
            option.textContent = group;
            select.append(option);
        }
    }

    async function refreshGroupOptions() {
        state.config = await request('/api/config');
        populateGroupSelect(registerGroup, state.config.groups);
        populateGroupSelect(document.getElementById('deadline-group'), state.config.groups);
        populateGroupSelect(document.getElementById('calendar-item-edit-group'), state.config.groups);
    }

    function openCalendarItemEdit(itemId) {
        const item = state.events.find((event) => event.id === itemId);
        if (!item) {
            return;
        }
        calendarItemEditForm.elements.namedItem('itemId').value = String(item.id);
        calendarItemEditForm.elements.namedItem('date').value = item.date;
        calendarItemEditForm.elements.namedItem('title').value = item.title;
        calendarItemEditForm.dataset.itemType = item.type;
        const groupField = document.getElementById('calendar-item-edit-group-field');
        const groupSelect = document.getElementById('calendar-item-edit-group');
        groupField.hidden = item.type !== 'deadline';
        groupSelect.required = item.type === 'deadline';
        groupSelect.value = item.groupName || '';
        showStatus(document.getElementById('calendar-item-edit-status'), '');
        calendarItemEditDialog.showModal();
    }

    function openOutingEdit(outingId) {
        if (state.user.role !== 'staff') {
            return;
        }
        const outing = state.outings.find((item) => item.id === outingId);
        if (!outing) {
            return;
        }
        outingEditForm.elements.namedItem('outingId').value = String(outing.id);
        outingEditForm.elements.namedItem('date').value = outing.date;
        outingEditForm.elements.namedItem('description').value = outing.description;
        showStatus(document.getElementById('outing-edit-status'), '');
        outingEditDialog.showModal();
    }

    function canDeleteOuting(outing) {
        if (state.user.role === 'staff') {
            return true;
        }
        if (outing.groupName !== state.user.group) {
            return false;
        }
        const createdAt = Date.parse(outing.createdAt);
        const age = Date.now() - createdAt;
        return Number.isFinite(createdAt) && age >= 0 && age <= 30 * 60 * 1000;
    }

    async function request(url, method = 'GET', body) {
        let response;
        try {
            response = await fetch(`${apiBaseUrl}${url}`, {
                method,
                credentials: 'include',
                headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch {
            throw new Error(apiBaseUrl
                ? 'Supabaseのサーバーに接続できません。'
                : 'サーバーに接続できません。プロジェクトで npm start を実行してください。');
        }

        let result;
        try {
            result = await response.json();
        } catch {
            throw new Error('サーバーから正しい応答を受け取れませんでした。');
        }
        if (!response.ok) {
            const error = new Error(result.error || '処理に失敗しました。');
            error.status = response.status;
            throw error;
        }
        return result;
    }

    function showStatus(element, message, isError = false) {
        element.textContent = message;
        element.classList.toggle('error', isError);
    }

    function toDateString(date) {
        return [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0')
        ].join('-');
    }

    function formatDate(value) {
        return new Intl.DateTimeFormat('ja-JP', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'short'
        }).format(new Date(`${value}T00:00:00`));
    }
});
