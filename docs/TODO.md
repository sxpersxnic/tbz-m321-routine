# TODO

- [x] "Notifications" page shows notifications but also shows runs, so two different things are shown in the same page. This is not only confusing but brings unwanted behavior, e.g. Every card shows "view run" but notifications don't have executions and just show an error. Separate notifications and runs into two different pages.

- [ ] In "Notifications" page, notifications are marked as read when the user clicks on the notification card. This is not intuitive and can be confusing. Clicking the notification card should open the notification details and mark it as read only when the user clicks on "Mark as read" button (displayed as icon).

- [ ] Currently a routines card shows all steps of the routine as icon. This is not scalable for routines with many steps. Don't show steps in the routines card.

- [ ] Currently a routine cards color and icon are based on the first step of the routine. Instead, users should be able to customize the color and icon of the routine card. Icon and colors can be set on creation of the routine, on edit of the routine, and when clicking the icon in the routine details page.

- [ ] In routine details page, the hero section shows icon, title, description, active toggle button, edit button (icon and label), copy button (icon only, secondary), delete button (icon only, secondary), execute button (icon and label, primary). This is too much information in a small space and is not scalable. The hero section should only show icon, title, description, active toggle button, edit button (icon only), and execute button (icon and label, primary). The copy and delete buttons should be moved to the "..." menu.

- [ ] In "Tasks" page, the component to create a new task is shown at the bottom of the page as inline form. This is not intuitive and can be confusing. Instead, the page should have a "Create Task" button at the top of the page, which opens a modal to create a new task.

- [ ] Users should be able to create custom lists for tasks. A custom list can have a name, description, and color. Users should be able to create a new list from the "Tasks" page, and when creating a new task, users should be able to select which list the task belongs to (needs to be configurable in routines aswell). The default list is "Todo". But keep the tabs to switch between "Today", "Scheduled", "Open", and "Done" at the top of the page, followed by the list of lists. When a user clicks on a list, the page should show all tasks in that list. The "Today", "Scheduled", "Open", and "Done" tabs should show tasks from all lists.

- [ ] "Inbox" page needs search, sort and filter functionality additional to "Mark all read" button.

- [ ] Single entries in "Inbox" page should be selectable, when atleast one entry is selected, a "Mark as read" and "Delete" buttons should be shown at the top of the page.
