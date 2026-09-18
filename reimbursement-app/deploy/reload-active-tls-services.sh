#!/bin/sh
set -eu
# Certificate renewal must never start the disabled 80/443 websites.
if /bin/systemctl is-active --quiet nginx; then
    /usr/sbin/nginx -t
    /bin/systemctl reload nginx
fi
if /bin/systemctl is-active --quiet reimbursement-api; then
    /usr/sbin/nginx -t -c /etc/reimbursement/nginx-api.conf
    /bin/systemctl reload reimbursement-api
fi
