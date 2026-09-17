-- Tie the ledger's customer and vendor dimensions to their sub-ledger tables.
-- Split out of 0005 so the sub-ledger tables could be created without altering
-- journal_lines while the posting engine was under construction.

-- Fail loudly rather than silently dropping a dangling reference.
do $$
declare bad int;
begin
  select count(*) into bad from journal_lines l
   where (l.customer_id is not null and not exists (select 1 from customers c where c.id = l.customer_id))
      or (l.vendor_id   is not null and not exists (select 1 from vendors   v where v.id = l.vendor_id));
  if bad > 0 then
    raise exception '% journal lines reference a customer or vendor that does not exist; resolve before adding the constraints', bad;
  end if;
end $$;

alter table journal_lines
  add constraint journal_lines_customer_fk foreign key (customer_id) references customers (id),
  add constraint journal_lines_vendor_fk   foreign key (vendor_id)   references vendors (id);
