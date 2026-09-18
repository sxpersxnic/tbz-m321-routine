# TODO

- [x] **REVIEWED**: "Notifications" page shows notifications but also shows runs, so two different things are shown in the same page. This is not only confusing but brings unwanted behavior, e.g. Every card shows "view run" but notifications don't have executions and just show an error. Separate notifications and runs into two different pages.

- [x] **REVIEWED**: In "Notifications" page, notifications are marked as read when the user clicks on the notification card. This is not intuitive and can be confusing. Clicking the notification card should open the notification details and mark it as read only when the user clicks on "Mark as read" button (displayed as icon).

- [x] **REVIEWED**: Currently a routines card shows all steps of the routine as icon. This is not scalable for routines with many steps. Don't show steps in the routines card.

- [x] **REVIEWED**: Currently a routine cards color and icon are based on the first step of the routine. Instead, users should be able to customize the color and icon of the routine card. Icon and colors can be set on creation of the routine, on edit of the routine, and when clicking the icon in the routine details page.

- [x] **REVIEWED**: In routine details page, the hero section shows icon, title, description, active toggle button, edit button (icon and label), copy button (icon only, secondary), delete button (icon only, secondary), execute button (icon and label, primary). This is too much information in a small space and is not scalable. The hero section should only show icon, title, description, active toggle button, edit button (icon only), and execute button (icon and label, primary). The copy and delete buttons should be moved to the "..." menu.

- [x] **REVIEWED**: In "Tasks" page, the component to create a new task is shown at the bottom of the page as inline form. This is not intuitive and can be confusing. Instead, the page should have a "Create Task" button at the top of the page, which opens a modal to create a new task.

- [x] Users should be able to create custom lists for tasks. A custom list can have a name, description, and color. Users should be able to create a new list from the "Tasks" page, and when creating a new task, users should be able to select which list the task belongs to (needs to be configurable in routines aswell). The default list is "Todo". But keep the tabs to switch between "Today", "Scheduled", "Open", and "Done" at the top of the page, followed by the list of lists. When a user clicks on a list, the page should show all tasks in that list. The "Today", "Scheduled", "Open", and "Done" tabs should show tasks from all lists.

- [x] "Inbox" page needs search, sort and filter functionality additional to "Mark all read" button.

- [x] Single entries in "Inbox" page should be selectable, when atleast one entry is selected, a "Mark as read" and "Delete" buttons should be shown at the top of the page.

- [x] Remove the blue dot which indicates unread notifications, since read/unread state is already indicated by the bold title and background color of the notification card. The blue dot is redundant and adds visual noise.

- [ ] Since all notifications have the same icon, it makes no sense to show the icon in the notification card. Remove the icon from the notification card.

- [ ] Instead of permanently displaying the checkbox to select a notification card, the checkbox should only be displayed when the user hovers over the notification card. This will reduce visual noise and make the page cleaner. Make sure to reserve space for the checkbox so that the notification card doesn't move when the checkbox is displayed.

- [ ] Users should be able to customize icon and color of a task list.

- [ ] Theres a bug on routine cards: The card can't be clicked anywhere on the vertical space where the run button is. For example:

  ```text
  Card:

  --------------------------
  |P1 Title                P2|
  |P3                      P3|
  |P4 <unclickable area> P5run button|
  --------------------------
  ```

  The card is not clickable in the area P4, which is the vertical space where the run button is. The card should be clickable anywhere on the card except for the run button (the button itself should be clickable but execute the action instead of opening the routine).

- [ ] The hero section of the routine details page should have a background color that is the same as the color of the routine card. This will make the page more visually appealing and consistent.

- [ ] The updated hero section now contains the "Active" toggle button, edit button, execute button and "..." menu. It is still too much, thats why we introduce a settings page for the routine. On the settings page, users should be able to edit the routine title, description, icon, color, active state and delete the routine. The settings page is accessible from the "..." menu in the hero section of the routine details page. So the hero section only contains the execute button and "..." menu as actions. So there is no edit page anymore, the edit button in the hero section is removed and the edit action is moved to the settings page. The settings page should also have a "Back" button to go back to the routine details page. The "..." menu has the options to go to the settings page and copy the routine.

- [ ] Add more possible actions to routines like sending emails, scripting blocks for conditions and loops, variables, functions etc. similar to apple shortcuts.
